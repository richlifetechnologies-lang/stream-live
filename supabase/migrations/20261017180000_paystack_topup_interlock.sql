-- ─────────────────────────────────────────────────────────────────────────────
-- Paystack checkout, part 2: the two doors must not both pay out.
--
-- A customer now has two ways to get minutes:
--   * the buy page — card or mobile money on Paystack's own screen, which credits
--     his account by itself, and
--   * the app's "ask the administrator for minutes" button, which queues a row for
--     him to approve by hand after a MoMo or Bitcoin payment he made outside the app.
--
-- Neither knows about the other. Two things go wrong without this file:
--
--   1. A buyer pays on the page, sees nothing move for a minute, panics, and files a
--      request for the same purchase. If the administrator approves it, the same money
--      pays out twice — once automatically, once by hand. The page and the app never
--      warn him, and the approve button happily grants again.
--   2. Once the online payment lands, that request sits in the queue for ever looking
--      like unpaid money, and the buyer's own list shows "pending" after he has paid.
--
-- So: the money function closes the matching request by itself, and the approve
-- function refuses to grant minutes that a Paystack order has already paid for.
--
-- Applies to the gateway database only. Nothing here touches the app's code.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- Shared: the online order that carries the reference a buyer typed into his request.
--
-- Matched on the reference text the buyer pasted, against both our own reference and
-- Paystack's transaction id, because a receipt he copies may carry either one. Trimmed
-- and lower-cased: people paste " SL-1A2B3C " out of an email.
--
-- 'paid' is included as well as 'credited' — the money is in and Paystack has said so,
-- but the minutes are still on their way. Approving over the top of that is exactly the
-- double payment this file exists to stop.
--
-- Security invoker on purpose: the panel calls it with a browser token, and the admin
-- policy on payments then decides what that caller can see. Called from inside the
-- definer functions below it reads as the owner, which is what the guard needs.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_gateway_match(p_reference text)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  -- An empty box must never match a row that has no reference of its own, so the
  -- whole match is skipped when the buyer typed nothing.
  select case
    when btrim(coalesce(p_reference, '')) = '' then null
    else (
      select to_jsonb(p)
      from public.payments p
      where p.status in ('paid', 'credited')
        and (
              p.reference = btrim(p_reference)
           or lower(p.reference) = lower(btrim(p_reference))
           or (coalesce(p.paystack_id, '') <> ''
               and (p.paystack_id = btrim(p_reference)
                    or lower(p.paystack_id) = lower(btrim(p_reference))))
        )
      order by p.credited_at desc nulls last, p.created_at desc
      limit 1
    )
  end;
$$;

comment on function public.sl_gateway_match(text) is
  'The online order carrying this reference, if it has been paid. Null when the buyer typed nothing.';

-- ─────────────────────────────────────────────────────────────────────────────
-- A payment that has landed closes the request that names it.
--
-- Only an exact reference match, and only from the same account. A buyer who paid by
-- MoMo and wrote "MTN 07:30" in the box instead of the order reference is left alone —
-- that request is genuinely his to approve, and guessing here would reject real money.
--
-- The status is 'rejected' because that is the only closed state the queue has; the
-- note is what he reads, so it says what happened in plain words and thanks nobody.
-- The app shows admin_note on the buyer's own list, which is the whole point: he paid,
-- he sees why the request closed, and he does not file another one.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_requests_autoclose(
  p_user      uuid,
  p_reference text,
  p_plan      text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  if p_user is null or btrim(coalesce(p_reference, '')) = '' then return 0; end if;

  update public.credit_requests
     set status     = 'rejected',
         admin_note = 'You paid for ' || p_plan || ' on the website with reference '
                      || p_reference
                      || '. Your minutes went into your account by themselves as soon as'
                      || ' the payment cleared, so this request needed no approval.'
   where user_id = p_user
     and status  = 'pending'
     and lower(btrim(coalesce(payment_reference, ''))) = lower(btrim(p_reference));

  get diagnostics v_n = row_count;
  return v_n;
end; $$;

revoke execute on function public.sl_requests_autoclose(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.sl_requests_autoclose(uuid, text, text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Every place an online payment delivers minutes, close the matching request.
-- Both routes run through sl_payment_deliver, so it is done once, inside it.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_payment_deliver(
  p_user      uuid,
  p_plan_id   text,
  p_reference text,
  p_channel   text default 'card'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan     public.plans;
  v_grants   jsonb := '[]'::jsonb;
  v_res      jsonb;
  v_minutes  integer;
  v_modality modality_flag;
  v_reason   text;
begin
  select * into v_plan from public.plans where id = p_plan_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'plan_missing');
  end if;

  v_reason := case p_channel
    when 'mobile_money' then 'Mobile money payment'
    when 'card'         then 'Card payment'
    else                     'Online payment'
  end || ' - ' || v_plan.name || ' (' || p_reference || ')';

  for v_modality, v_minutes in
    select * from (values
      ('video'::modality_flag,       coalesce(v_plan.video_minutes, 0)),
      ('audio'::modality_flag,       coalesce(v_plan.audio_minutes, 0)),
      ('video_audio'::modality_flag, coalesce(v_plan.video_audio_minutes, 0))
    ) as b(modality, minutes) where b.minutes > 0
  loop
    v_res := public.sl_grant_credits(v_user, v_modality, v_minutes, v_reason, null, null);
    if v_res is null or v_res->>'ok' is distinct from 'true' then
      raise exception 'grant failed for %: %', v_modality,
        coalesce(v_res->>'error', 'no answer from the credit function');
    end if;
    v_grants := v_grants || jsonb_build_array(jsonb_build_object(
      'modality', v_modality::text, 'minutes', v_minutes, 'balance', v_res->'balance'));
  end loop;

  if v_grants = '[]'::jsonb then
    return jsonb_build_object('ok', false, 'error', 'plan_has_no_minutes');
  end if;

  insert into public.subscriptions (user_id, plan_id, status)
  values (v_user, v_plan.id, 'active')
  on conflict (user_id) do update
    set plan_id          = excluded.plan_id,
        status           = 'active',
        billing_provider = 'paystack',
        billing_ref      = p_reference,
        updated_at       = now();

  -- The money is in and the minutes are granted. If this same buyer had also filed a
  -- request naming this reference, it is finished business — close it now so his queue
  -- and the buyer's own screen both stop showing an unpaid top-up that was paid.
  perform public.sl_requests_autoclose(v_user, p_reference, v_plan.name);

  return jsonb_build_object('ok', true, 'user_id', v_user, 'plan', v_plan.name,
                            'grants', v_grants, 'reason', v_reason);
end; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The approve button refuses to pay out money Paystack has already paid out.
--
-- Same body as the shipped function with one block added before the grant. Read the
-- refusal as the administrator: Approve stops, and the message tells you which order
-- already paid and what to do. Reject the request, or grant by hand from the account
-- screen if you disagree — this guard only speaks for the approve button, never for
-- you. A request with no reference in it is never blocked, because MoMo payments
-- outside the app have no reference either and that business must keep flowing.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_resolve_request(
  p_request_id uuid,
  p_approve    boolean,
  p_admin      uuid,
  p_note       text default null,
  p_minutes    numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req   public.credit_requests;
  v_grant numeric;
  v_res   jsonb;
  v_pay   jsonb;
begin
  select * into v_req from public.credit_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'request not found'); end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already_' || v_req.status);
  end if;

  if p_approve then
    v_pay := public.sl_gateway_match(v_req.payment_reference);
    if v_pay is not null then
      return jsonb_build_object('ok', false,
        'error', 'This request names online order ' || (v_pay->>'reference')
          || ', which ' || (case when v_pay->>'status' = 'credited'
               then 'has already been paid for and credited to ' || coalesce(v_pay->>'email', 'that buyer')
               || ' - the minutes are in the account now. Reject this request; approving it would hand out the same purchase twice.'
               else 'Paystack has taken but not yet credited (the page or the webhook credits it by itself within a minute). Reject this request and let the payment land rather than granting over the top of it.'
             end),
        'reference', v_pay->>'reference', 'order_status', v_pay->>'status',
        'paid_email', v_pay->>'email', 'plan_id', v_pay->>'plan_id');
    end if;
  end if;

  v_grant := coalesce(p_minutes, v_req.minutes);

  if p_approve then
    v_res := public.sl_grant_credits(v_req.user_id, v_req.modality, v_grant,
                                     'top-up approved (request ' || left(v_req.id::text, 8) || ')',
                                     p_admin, v_req.id);
    update public.credit_requests
       set status = 'approved', admin_id = p_admin, admin_note = p_note
     where id = p_request_id;
    return jsonb_build_object('ok', true, 'status', 'approved', 'minutes', v_grant,
                              'user_id', v_req.user_id, 'modality', v_req.modality::text,
                              'grant', v_res);
  else
    update public.credit_requests
       set status = 'rejected', admin_id = p_admin, admin_note = p_note
     where id = p_request_id;
    return jsonb_build_object('ok', true, 'status', 'rejected', 'request_id', p_request_id);
  end if;
end; $$;

comment on function public.sl_resolve_request(uuid, boolean, uuid, text, numeric) is
  'Approve or reject a top-up request. Refuses approval when the reference names a paid online order.';

-- The panel reads the online order behind a request through this function, so the
-- browser must be allowed to call it. It is SECURITY INVOKER, so a browser call is
-- already limited to what the administrator's read policy permits; when the gateway
-- calls it from inside sl_resolve_request it runs as the owner and sees every row,
-- which is what the guard above needs.
grant execute on function public.sl_gateway_match(text) to authenticated, service_role;
