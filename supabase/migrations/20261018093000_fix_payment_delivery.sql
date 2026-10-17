-- Fix the one function every online payment delivers its minutes through.
--
-- What went wrong, in the order it was discovered. A customer paid real money, Paystack
-- answered Success, the seller's Payments tab kept reading "waiting", and pressing Ask
-- answered: "The credit could not be written: column v_user does not exist."
--
-- The shipped function takes the account as p_user, but its body was copied from an older
-- draft that named the same value v_user. plpgsql has no such variable, so it reads the
-- word as a column of whatever table the statement happens to touch and fails at run time
-- on the first line that asks for a grant. Nothing before it wrote anything, so the whole
-- credit call rolled back and the order stayed exactly as it was opened - which is why the
-- tab said "waiting" for money that was already in the till.
--
-- This has affected every online payment, not only this one, and no amount of webhook
-- configuration could have fixed it: the call-back reached the order, asked for the credit,
-- and the same line failed. A sweep of all sixty-eight functions in the migration history
-- found this name used in two copies of this one function and nowhere else.
--
-- The body is otherwise the shipped one, including the block that closes a matching top-up
-- request, because a buyer whose payment arrived should not have to ask twice.

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
  if p_user is null then
    return jsonb_build_object('ok', false, 'error', 'no_account_to_credit');
  end if;

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
    v_res := public.sl_grant_credits(p_user, v_modality, v_minutes, v_reason, null, null);
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
  values (p_user, v_plan.id, 'active')
  on conflict (user_id) do update
    set plan_id          = excluded.plan_id,
        status           = 'active',
        billing_provider = 'paystack',
        billing_ref      = p_reference,
        updated_at       = now();

  perform public.sl_requests_autoclose(p_user, p_reference, v_plan.name);

  return jsonb_build_object('ok', true, 'user_id', p_user, 'plan', v_plan.name,
                            'grants', v_grants, 'reason', v_reason);
end; $$;

comment on function public.sl_payment_deliver(uuid, text, text, text) is
  'Grant the minutes of a paid package and point the subscription at it. Called only by the'
  ' payment settlement functions, as the service role.';
