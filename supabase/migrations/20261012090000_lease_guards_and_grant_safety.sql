-- Lease guards, key-pool limits and grant safety.
--
-- Everything here closes a hole the gateway currently leaves open:
--   * nothing reaps an abandoned lease on a schedule;
--   * nothing limits how many video calls run at once against fal, whose
--     concurrency cap is per billing workspace, not per key or per account;
--   * a missing burn-rate row silently bills 1.0 for every modality;
--   * two identical admin grants 3 seconds apart both spend money.
--
-- Safe to run more than once.

-- ── 1. app_config: one new knob, off by default ───────────────────────────────
-- null/0 = uncapped, so applying this migration changes nothing until the
-- administrator sets a number in the admin panel.
alter table public.app_config
  add column if not exists max_concurrent_video_sessions integer;

comment on column public.app_config.max_concurrent_video_sessions is
  'How many video or video+voice leases may be live across ALL accounts at once. fal caps concurrency per billing workspace, so this is the workspace ceiling. null = uncapped.';

-- ── 2. burn rate: never silently bill the priciest modality at 1.0 ────────────
create or replace function public.current_burn_rate(p_modality modality_flag)
returns numeric
language sql
stable
as $$
  select coalesce(
    (
      select multiplier from public.burn_rates
      where modality = p_modality and effective_from <= now() and retired_at is null
      order by effective_from desc, id desc
      limit 1
    ),
    -- Retired or missing row: fall back to the seeded multipliers rather than to
    -- a flat 1.0, which under-charges voice+video by a third.
    case p_modality
      when 'video'       then 1.000
      when 'audio'       then 0.500
      when 'video_audio' then 1.500
    end
  );
$$;

-- ── 3. sl_start_session: enforce the workspace-wide video ceiling ─────────────
create or replace function public.sl_start_session(
  p_user     uuid,
  p_modality modality_flag,
  p_tab      text,
  p_device   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub      record;
  v_enabled  boolean;
  v_balance  numeric(10,3);
  v_unlimited boolean;
  v_cfg      record;
  v_open     integer;
  v_video_open integer;
  v_chunk    numeric(10,3);
  v_session  uuid;
  v_mult     numeric(6,3);
begin
  -- Close anything that ran past its lease before we count open sessions.
  perform public.sl_reap_sessions(p_user);

  select * into v_sub from public.subscriptions where user_id = p_user;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'no_subscription');
  end if;
  if v_sub.status not in ('active') then
    return jsonb_build_object('allowed', false, 'reason', 'status_' || v_sub.status::text);
  end if;

  v_enabled := case p_modality
    when 'video'       then v_sub.video_enabled
    when 'audio'       then v_sub.audio_enabled
    when 'video_audio' then v_sub.video_audio_enabled
  end;
  if v_enabled is not true then
    return jsonb_build_object('allowed', false, 'reason', 'modality_disabled');
  end if;

  select * into v_cfg from public.app_config where id = 1;
  if coalesce(v_cfg.maintenance, false) then
    return jsonb_build_object('allowed', false, 'reason', 'maintenance',
                              'message', coalesce(v_cfg.maintenance_message, 'gateway under maintenance'));
  end if;

  v_chunk := v_cfg.lease_chunk_minutes;
  v_mult := public.current_burn_rate(p_modality);

  insert into public.credit_balances (user_id, modality, balance)
  values (p_user, p_modality, 0)
  on conflict (user_id, modality) do nothing;

  select balance, unlimited into v_balance, v_unlimited
  from public.credit_balances
  where user_id = p_user and modality = p_modality
  for update;

  if not v_unlimited then
    if v_balance < 1 then
      return jsonb_build_object('allowed', false, 'reason', 'out_of_minutes',
                                'balance', v_balance, 'modality', p_modality::text);
    end if;
    if v_chunk > v_balance then v_chunk := v_balance; end if;
  else
    v_chunk := 0;
  end if;

  -- Concurrency: how many leases are still live for this account?
  select count(*) into v_open
  from public.usage_sessions
  where user_id = p_user
    and ended_at is null
    and lease_expires_at > now();
  if v_open >= greatest(v_sub.max_concurrent_sessions, 1) then
    return jsonb_build_object('allowed', false, 'reason', 'concurrent_limit',
                              'open_sessions', v_open,
                              'max_concurrent_sessions', v_sub.max_concurrent_sessions);
  end if;

  -- Workspace ceiling: every video-capable modality shares the same fal account,
  -- and fal rejects the call past its concurrency cap. Refusing here costs a
  -- "lines are busy" message instead of a failed call and a burnt lease.
  -- Checked before the pre-debit, so nothing has been taken from the wallet yet.
  if coalesce(v_cfg.max_concurrent_video_sessions, 0) > 0
     and p_modality in ('video', 'video_audio') then
    select count(*) into v_video_open
    from public.usage_sessions
    where ended_at is null
      and lease_expires_at > now()
      and modality in ('video', 'video_audio');
    if v_video_open >= v_cfg.max_concurrent_video_sessions then
      return jsonb_build_object('allowed', false, 'reason', 'lines_busy',
                                'open_video_sessions', v_video_open,
                                'max_concurrent_video_sessions', v_cfg.max_concurrent_video_sessions);
    end if;
  end if;

  insert into public.usage_sessions
    (user_id, device_id, tab, modality, feature, started_at,
     lease_started_at, lease_expires_at, pending_debit, multiplier)
  values
    (p_user, p_device, p_tab, p_modality,
     case p_modality when 'audio' then 'voice'::feature_flag else 'video'::feature_flag end,
     now(), now(),
     now() + make_interval(secs => v_cfg.lease_ttl_seconds),
     v_chunk, v_mult)
  returning id into v_session;

  if v_chunk > 0 then
    update public.credit_balances
       set balance = round((balance - v_chunk)::numeric, 3),
           total_spent = total_spent + v_chunk,
           updated_at = now()
     where user_id = p_user and modality = p_modality;

    insert into public.credit_ledger
      (user_id, modality, kind, delta, balance_after, reason, session_id)
    values
      (p_user, p_modality, 'debit', -v_chunk,
       (select balance from public.credit_balances where user_id = p_user and modality = p_modality),
       'lease opened', v_session);
  end if;

  return jsonb_build_object(
    'allowed', true,
    'session_id', v_session,
    'modality', p_modality::text,
    'chunk_minutes', v_chunk,
    'lease_ttl_seconds', v_cfg.lease_ttl_seconds,
    'multiplier', v_mult,
    'unlimited', v_unlimited,
    'balance', (select balance from public.credit_balances where user_id = p_user and modality = p_modality)
  );
end; $$;

-- ── 4. sl_grant_credits: an accidental double-click must not pay twice ────────
-- A grant is considered a repeat when the same administrator posts the same
-- amount to the same bucket with the same reason within 15 seconds. Anything a
-- human would do twice on purpose (a different amount, a different reason, or
-- after a quarter of a minute) still goes through.
create or replace function public.sl_grant_credits(
  p_user     uuid,
  p_modality modality_flag,
  p_minutes  numeric,
  p_reason   text,
  p_actor    uuid        default null,
  p_request_id uuid      default null,
  p_unlimited boolean    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance   numeric(10,3);
  v_unlimited boolean;
  v_after     numeric(10,3);
  v_repeat    integer;
  v_switched  boolean;
begin
  if p_minutes is null or p_modality is null then
    return jsonb_build_object('ok', false, 'error', 'minutes and modality are required');
  end if;

  select count(*) into v_repeat
  from public.credit_ledger
  where user_id = p_user
    and modality = p_modality
    and delta = round(p_minutes, 3)
    and coalesce(reason, '') = coalesce(p_reason, 'manual')
    and actor_id is not distinct from p_actor
    and created_at > now() - interval '15 seconds';
  if v_repeat > 0 then
    return jsonb_build_object('ok', false, 'deduped', true,
      'error', 'the same grant was recorded a few seconds ago - nothing was changed');
  end if;

  insert into public.credit_balances (user_id, modality, balance)
  values (p_user, p_modality, 0)
  on conflict (user_id, modality) do nothing;

  select balance, unlimited into v_balance, v_unlimited
  from public.credit_balances
  where user_id = p_user and modality = p_modality
  for update;

  v_switched := p_unlimited is not null and p_unlimited is distinct from v_unlimited;
  if p_unlimited is not null then
    v_unlimited := p_unlimited;
    update public.credit_balances set unlimited = v_unlimited
    where user_id = p_user and modality = p_modality;
  end if;

  v_after := round((v_balance + p_minutes)::numeric, 3);
  if v_after < 0 then v_after := 0; end if;   -- deductions clamp at zero

  update public.credit_balances
     set balance = v_after,
         total_credited = total_credited + greatest(p_minutes, 0),
         total_spent    = total_spent - least(p_minutes, 0),
         updated_at = now()
   where user_id = p_user and modality = p_modality;

  insert into public.credit_ledger
    (user_id, modality, kind, delta, balance_after, reason, request_id, actor_id)
  values
    (p_user, p_modality,
     case when p_minutes >= 0 then 'credit' else 'adjust' end,
     round(p_minutes, 3), v_after, coalesce(p_reason, 'manual'), p_request_id, p_actor);

  -- The unlimited switch changes what the account can spend without moving a
  -- single minute, so it needs its own ledger row or the audit trail has a hole.
  if v_switched then
    insert into public.credit_ledger
      (user_id, modality, kind, delta, balance_after, reason, request_id, actor_id)
    values
      (p_user, p_modality, 'adjust', 0, v_after,
       case when v_unlimited then 'access switched to unlimited' else 'access switched to metered' end,
       p_request_id, p_actor);
  end if;

  return jsonb_build_object('ok', true, 'balance', v_after, 'unlimited', v_unlimited);
end; $$;

-- ── 5. key pool: index the cooldown read ─────────────────────────────────────
-- The Edge Functions skip a key that failed 3 times in 10 minutes; without this
-- index that check scans a growing log on every AI call.
create index if not exists key_usage_log_fail_idx
  on public.key_usage_log (key_id, created_at desc)
  where outcome = 'fail';

-- ── 6. reap abandoned leases on a schedule ───────────────────────────────────
-- Today a dead lease is only closed when that same user starts their next call,
-- or when an admin clicks reconcile. In between, the session sits open with its
-- pre-debit held and the admin panel shows a call that isn't happening.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'cron' and p.proname = 'schedule') then
    if exists (select 1 from cron.job where jobname = 'stream_live_reap_leases') then
      perform cron.unschedule('stream_live_reap_leases');
    end if;
    perform cron.schedule(
      'stream_live_reap_leases',
      '*/5 * * * *',
      'select public.sl_reap_sessions(null)'
    );
    raise notice 'lease reaper scheduled every 5 minutes';
  else
    raise notice 'pg_cron is not installed on this project — enable Database -> Extensions -> pg_cron, or add a Scheduler job calling sl_reap_sessions(null) every 5 minutes';
  end if;
end; $$;
