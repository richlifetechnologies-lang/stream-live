-- -- Money that goes back brings the minutes back with it ----------------------
-- The receipt reader is careful on the way in: it will not hand out minutes for money that
-- had already been returned, because Paystack still calls a refunded charge a success and a
-- mobile-money reversal arrives as a state of its own. That half is right and stays as it is.
--
-- The half that was missing is the timing after. A payment can be credited in good faith and
-- refunded weeks later - a bank charge-back, a customer who changed their story, a mobile
-- money reversal that lands after the fact. Paystack sends a message for it, and this gateway
-- only ever listened for "payment succeeded", so the message arrived, was ignored, and the
-- customer kept spending minutes they no longer paid for.
--
-- sl_paystack_clawback closes that. It works from what the wallet was actually given, which is
-- the ledger entry the delivery wrote with this order's own reference on it, so it takes back
-- what went in and no more. Where the customer has already spent part of it the rest is left
-- alone and written plainly on the order - pushing a balance below zero would charge them for
-- calls they had paid for with other money.
--
-- It is safe to call twice, and from either direction. An order that was never credited is
-- simply marked as returned, which is what the re-check already did, and a second pass finds
-- the order closed and does nothing. Both doors now go through it: Paystack's own call-back,
-- and the re-check that the buyer's page and the seller's Payments tab both run.
--
-- The subscription row is deliberately left alone. Dropping a plan changes how many lines an
-- account may hold and which tabs it sees, which is a bigger hammer than taking back the
-- minutes one order bought; with those gone the wallet gate refuses the next call anyway.

-- One bucket, one take-back, so both sources of truth below reach the same arithmetic and the
-- same ledger entry. Returns what it moved: minutes taken, minutes it could not reach.
create or replace function public.sl_take_back_minutes(
  p_user     uuid,
  p_modality modality_flag,
  p_granted  numeric,
  p_reason   text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bal  numeric;
  v_unlim boolean;
  v_take numeric;
  v_left numeric;
begin
  if p_user is null or p_granted is null or p_granted <= 0 then
    return jsonb_build_object('taken', 0, 'shortfall', 0);
  end if;

  select balance, unlimited into v_bal, v_unlim
  from public.credit_balances
  where user_id = p_user and modality = p_modality
  for update;
  if not found then
    return jsonb_build_object('taken', 0, 'shortfall', round(p_granted::numeric, 3));
  end if;
  v_bal := coalesce(v_bal, 0);

  -- An unlimited bucket holds no money that came from this order.
  if coalesce(v_unlim, false) then
    return jsonb_build_object('taken', 0, 'shortfall', 0);
  end if;

  v_take := round(least(v_bal, p_granted)::numeric, 3);
  v_left := round(greatest(0, p_granted - v_take)::numeric, 3);

  if v_take > 0 then
    update public.credit_balances
       set balance = round((balance - v_take)::numeric, 3),
           total_spent = greatest(0, total_spent - v_take),
           updated_at = now()
     where user_id = p_user and modality = p_modality;

    insert into public.credit_ledger (user_id, modality, kind, delta, balance_after, reason)
    values (p_user, p_modality, 'adjust', -v_take,
            (select balance from public.credit_balances
              where user_id = p_user and modality = p_modality),
            p_reason);
  end if;

  return jsonb_build_object('taken', v_take, 'shortfall', v_left);
end; $$;

create or replace function public.sl_paystack_clawback(
  p_reference text,
  p_reason    text default 'Paystack returned this payment to the payer'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pay    public.payments;
  v_note   text;
  v_taken  jsonb := '[]'::jsonb;
  v_short  jsonb := '[]'::jsonb;
  v_res    jsonb;
  v_row    record;
  v_source text := 'ledger';
begin
  if coalesce(trim(p_reference), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'no_reference');
  end if;

  select * into v_pay from public.payments where reference = p_reference for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown_reference', 'reference', p_reference);
  end if;

  v_note := coalesce(nullif(trim(p_reason), ''), 'Paystack returned this payment to the payer');

  -- Nothing was ever delivered, so there is nothing to take back. Record the return.
  if v_pay.credited_at is null then
    update public.payments set status = 'refunded', note = v_note where id = v_pay.id;
    return jsonb_build_object('ok', true, 'clawed', false, 'reference', p_reference);
  end if;

  -- Already dealt with: the delivery is on record and the order is closed as returned.
  if v_pay.status = 'refunded' then
    return jsonb_build_object('ok', true, 'deduped', true, 'reference', p_reference);
  end if;

  if v_pay.user_id is null then
    update public.payments
       set status = 'refunded',
           note = v_note || ', but no account is recorded on this order, so nothing could be taken back'
     where id = v_pay.id;
    return jsonb_build_object('ok', true, 'clawed', false, 'orphan', true, 'reference', p_reference);
  end if;

  for v_row in
    select l.modality, sum(l.delta) as granted
    from public.credit_ledger l
    where l.user_id = v_pay.user_id
      and l.kind = 'credit'
      -- The reference sits in brackets at the end of the delivery's own reason. position()
      -- rather than LIKE because a Paystack reference may itself contain an underscore, which
      -- LIKE would read as a wildcard.
      and position('(' || p_reference || ')' in coalesce(l.reason, '')) > 0
    group by l.modality
    having sum(l.delta) > 0
  loop
    v_res := public.sl_take_back_minutes(v_pay.user_id, v_row.modality, v_row.granted,
      'Payment returned - ' || coalesce((select p.name from public.plans p where p.id = v_pay.plan_id), 'online payment')
      || ' (' || p_reference || ')');
    v_taken := v_taken || jsonb_build_array(jsonb_build_object(
      'modality', v_row.modality::text, 'minutes', v_res->'taken'));
    if (v_res->>'shortfall')::numeric > 0 then
      v_short := v_short || jsonb_build_array(jsonb_build_object(
        'modality', v_row.modality::text, 'minutes', v_res->'shortfall'));
    end if;
  end loop;

  -- An order credited before the ledger carried this shape of reason: fall back to what the
  -- delivery itself reported granting, one modality at a time.
  if v_taken = '[]'::jsonb and v_pay.credit_result ? 'grants' then
    v_source := 'credit_result';
    for v_row in
      select (g->>'modality')::modality_flag as modality,
             (g->>'minutes')::numeric as granted
      from jsonb_array_elements(v_pay.credit_result->'grants') as g
      where coalesce(g->>'modality', '') in ('video', 'audio', 'video_audio')
        and coalesce(g->>'minutes', '') ~ '^[0-9]+([.][0-9]+)?$'
    loop
      v_res := public.sl_take_back_minutes(v_pay.user_id, v_row.modality, v_row.granted,
        'Payment returned - ' || coalesce((select p.name from public.plans p where p.id = v_pay.plan_id), 'online payment')
        || ' (' || p_reference || ')');
      v_taken := v_taken || jsonb_build_array(jsonb_build_object(
        'modality', v_row.modality::text, 'minutes', v_res->'taken'));
      if (v_res->>'shortfall')::numeric > 0 then
        v_short := v_short || jsonb_build_array(jsonb_build_object(
          'modality', v_row.modality::text, 'minutes', v_res->'shortfall'));
      end if;
    end loop;
  end if;

  update public.payments
     set status = 'refunded',
         note = v_note || case when v_short = '[]'::jsonb then ''
                               else ' - partly recovered, still owed: ' || (
                                      select string_agg(x->>'modality' || ' ' || (x->>'minutes') || ' min', ', ')
                                      from jsonb_array_elements(v_short) as x
                                    ) end
   where id = v_pay.id;

  return jsonb_build_object('ok', true, 'clawed', v_taken <> '[]'::jsonb, 'reference', p_reference,
                            'taken', v_taken, 'shortfall', v_short, 'source', v_source);
end; $$;

revoke execute on function public.sl_paystack_clawback(text, text) from public, anon, authenticated;
revoke execute on function public.sl_take_back_minutes(uuid, modality_flag, numeric, text)
  from public, anon, authenticated;
grant  execute on function public.sl_paystack_clawback(text, text) to service_role;

comment on function public.sl_paystack_clawback(text, text) is
  'Take back the minutes an order granted once Paystack returns that money. Idempotent, and '
  'service role only: Paystack''s own answer is the only thing that may trigger it.';
