-- The package side of the one pool: nothing a package sells can be a second wallet.
--
-- Since 20261101120000 both call tabs draw their minutes from ONE wallet - sl_pay_bucket()
-- answers 'video' for the video_audio modality, and the panel's "Credit this package" button
-- deliberately folds a package's two figures into one grant. The settlement function was not
-- folded with it, and it still walks three legs, one per column, handing each to
-- sl_grant_credits with the SAME reason text (the reason names the package and the Paystack
-- reference, never the leg). Two of those three legs now land in the same wallet, so:
--
--   * a package priced with the same figure on the Video line and the Video + Audio line grants
--     twice with an identical account, wallet, amount and reason inside one second. The
--     duplicate guard that came in with the pool reads the second grant as an accidental repeat
--     and refuses it, and sl_payment_deliver treats a refused grant as a failed settlement and
--     RAISES - so the credit rolls back whole. Paystack would have the money, the buyer would
--     have no minutes, and the Payments tab would keep reading "waiting".
--   * a package priced with different figures on those two lines would over-credit the pool,
--     because the second line is no longer a separate wallet to spend from.
--
-- Neither is a live fault. The read-only audit of 2026-11-01 went through every row of the
-- catalogue and found 0 on that line for all eleven packages, so no buyer has ever met either
-- case and nothing here moves a single stored figure. This is the guard that keeps that true
-- when somebody later types a number into a box - so the box is being closed too, in the panel.

-- ── 1. Settlement grants once per wallet, which is what one pool means ─────────
-- The body is the shipped one from 20261018093000 with only the leg list changed: the pool leg
-- carries both printed video figures added together, so a package can never lose the minutes
-- its shelf promised, and one wallet is asked for exactly once per delivery. The audio leg is
-- kept exactly as it was - it is a different wallet, it cannot collide, and no package on the
-- shelf is priced with it.

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
      -- One ask per wallet, on purpose. The Video + Audio tab spends this same pool figure at
      -- its own burn rate, so the retired second column is added into it instead of being
      -- granted beside it.
      ('video'::modality_flag, coalesce(v_plan.video_minutes, 0)
                               + coalesce(v_plan.video_audio_minutes, 0)),
      ('audio'::modality_flag, coalesce(v_plan.audio_minutes, 0))
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
  ' payment settlement functions, as the service role. One grant per wallet: the pool covers'
  ' both call tabs, so the retired Video + Audio column folds into the video ask.';

-- ── 2. The package write door: a new figure on the retired line cannot be created ──
-- A BEFORE trigger that folds rather than refuses, because refusing would strand a package the
-- Prices tab's ladder or an older copy of the panel had already written, and a buyer who paid
-- for a printed figure must never be handed less. The fold is idempotent - once the line is 0 it
-- changes nothing at all.
--
-- It only acts when THIS statement is the one moving that figure, so pressing "On sale" or
-- editing a name can never shuffle minute figures behind his back.

create or replace function public.sl_plans_one_pool()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Nested on purpose: a boolean AND in SQL is not promised to skip its right side, and asking
  -- for the old row during an INSERT is an error. The figure is only looked at when this
  -- statement is the one moving it.
  if TG_OP = 'UPDATE' then
    if NEW.video_audio_minutes is not distinct from OLD.video_audio_minutes then
      return NEW;
    end if;
  end if;
  if coalesce(NEW.video_audio_minutes, 0) <> 0 then
    NEW.video_minutes       := coalesce(NEW.video_minutes, 0) + NEW.video_audio_minutes;
    NEW.video_audio_minutes := 0;
  end if;
  return NEW;
end; $$;

comment on function public.sl_plans_one_pool() is
  'BEFORE insert/update row trigger on public.plans: a write that puts a figure on the retired'
  ' Video + Audio column folds it into the single pool column and leaves that line at 0. Does'
  ' nothing to a row this statement is not re-pricing.';

comment on column public.plans.video_audio_minutes is
  'Retired by the one pool (20261101120000): the Video + Audio tab spends video_minutes at its'
  ' own burn rate, so this line sells nothing separate. Kept so older packages stay readable;'
  ' sl_plans_one_pool folds any figure written to it into video_minutes, and'
  ' sl_payment_deliver adds it into the single pool grant rather than asking twice.';

drop trigger if exists sl_plans_one_pool on public.plans;
create trigger sl_plans_one_pool
  before insert or update on public.plans
  for each row execute function public.sl_plans_one_pool();
