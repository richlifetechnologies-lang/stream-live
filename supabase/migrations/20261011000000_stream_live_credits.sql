-- ─────────────────────────────────────────────────────────────────────────────
-- STREAM LIVE — credit model (manual top-ups, three non-expiring wallets).
--
-- What changes vs. the old subscription/period model:
--   * NO TRIALS and NO EXPIRY. status default becomes 'active'; current_period_end
--     is never enforced again (kept only so old rows/panels don't break).
--   * One wallet per MODALITY — 'video' (Video Call), 'audio' (Audio Call),
--     'video_audio' (Video + Audio). Minutes never reset; they sit in the bucket
--     until spent. public.credit_balances is the live balance, public.credit_ledger
--     is the append-only history of every change.
--   * Atomic LEASES. A call pre-debits a small chunk of wallet minutes inside one
--     transaction with SELECT ... FOR UPDATE on the balance row, so two devices of
--     the same account can never spend the same minute twice. Unused chunk is
--     refunded on renew/settle.
--   * Manual top-ups: users file a public.credit_requests row, admin approves it and
--     the same RPC credits the bucket, linked by request_id.
--   * Admin key pool: gateway_keys gains provider/enabled/priority/daily caps,
--     per-account assignment lives in public.user_key_assignments, and every use is
--     logged to public.key_usage_log (failover history).
--   * Burn rates are versioned per modality (public.burn_rates) instead of the three
--     fixed timer_config columns.
--   * public.app_config carries the minimum supported desktop version (kill switch),
--     lease sizing and the signup/maintenance switches.
--
-- Money math lives ONLY in these SECURITY DEFINER functions, which are granted to
-- service_role and nothing else — a client JWT can never call them. Edge Functions
-- (service role) are the only caller.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Modality enum ────────────────────────────────────────────────────────────
do $$ begin
  create type modality_flag as enum ('video', 'audio', 'video_audio');
exception when duplicate_object then null; end $$;

-- Desktop tab id -> bucket. Unknown tabs fall back to the combined bucket, which is
-- the most expensive one, so a mis-labelled client can never under-bill.
create or replace function public.modality_for_tab(p_tab text)
returns modality_flag
language sql
immutable
as $$
  select case
    when p_tab = 'video-only' then 'video'::modality_flag
    when p_tab = 'audio-only' then 'audio'::modality_flag
    else 'video_audio'::modality_flag
  end;
$$;

-- ── No trials: retire the 'trialing' default ─────────────────────────────────
update public.subscriptions set status = 'active' where status = 'trialing';
alter table public.subscriptions alter column status set default 'active';

-- Per-account switches + concurrency cap.
alter table public.subscriptions
  add column if not exists video_enabled           boolean not null default true,
  add column if not exists audio_enabled           boolean not null default true,
  add column if not exists video_audio_enabled     boolean not null default true,
  add column if not exists max_concurrent_sessions integer not null default 2;

-- ── Self-signup provisioning ─────────────────────────────────────────────────
-- An account created at the sign-up screen must be usable immediately: without a
-- subscription row the gateway answers 'no_subscription', which reads like a bug to
-- a new user. They get the starter plan with an empty wallet, so the first call
-- still refuses with 'out_of_minutes' until an admin credits it. This is not a
-- trial — nothing is granted here.
create or replace function public.sl_provision_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan text;
begin
  v_plan := coalesce(
    (select id from public.plans where id = 'starter'),
    (select min(id) from public.plans where active),
    (select min(id) from public.plans));
  if v_plan is null then return new; end if;   -- plans not configured yet
  insert into public.subscriptions (user_id, plan_id, status)
  values (new.id, v_plan, 'active')
  on conflict (user_id) do nothing;
  return new;
end; $$;

drop trigger if exists sl_provision_subscription on public.profiles;
create trigger sl_provision_subscription
  after insert on public.profiles
  for each row execute function public.sl_provision_subscription();

-- Accounts that signed up before this migration.
insert into public.subscriptions (user_id, plan_id, status)
select p.id, coalesce((select id from public.plans where id = 'starter'), (select min(id) from public.plans)), 'active'
  from public.profiles p
 where not exists (select 1 from public.subscriptions s where s.user_id = p.id)
   and coalesce((select id from public.plans where id = 'starter'), (select min(id) from public.plans)) is not null
on conflict (user_id) do nothing;

-- Concurrent devices are allowed by product decision, so the plan every new account
-- lands on has to permit more than one install; otherwise device binding would
-- contradict max_concurrent_sessions. Adjust per plan in the panel afterwards.
update public.plans set max_devices = greatest(max_devices, 2) where id = 'starter';

-- ── credit_balances: one row per user x modality ─────────────────────────────
create table if not exists public.credit_balances (
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  modality   modality_flag not null,
  balance    numeric(10,3) not null default 0 check (balance >= 0),
  unlimited  boolean       not null default false,  -- admin flag: never debited
  total_credited numeric(12,3) not null default 0,  -- lifetime, for the panel
  total_spent    numeric(12,3) not null default 0,
  updated_at timestamptz   not null default now(),
  primary key (user_id, modality)
);
create index if not exists credit_balances_user_idx on public.credit_balances (user_id);

-- ── credit_ledger: append-only history ───────────────────────────────────────
create table if not exists public.credit_ledger (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  user_id       uuid        not null references public.profiles (id) on delete cascade,
  modality      modality_flag not null,
  kind          text        not null check (kind in ('credit','debit','release','adjust')),
  delta         numeric(10,3) not null,           -- signed wallet minutes
  balance_after numeric(10,3),
  reason        text,                             -- 'top-up approved', 'call 1234abcd'
  session_id    uuid,
  request_id    uuid,
  actor_id      uuid                              -- admin who acted, when applicable
);
create index if not exists credit_ledger_user_created_idx on public.credit_ledger (user_id, created_at desc);
create index if not exists credit_ledger_session_idx on public.credit_ledger (session_id);

-- Corrections are new rows ('adjust'), never edits.
create or replace function public.sl_ledger_no_update()
returns trigger language plpgsql as $$
begin
  raise exception 'credit_ledger is append-only; post an adjust row instead';
end; $$;

drop trigger if exists credit_ledger_no_update on public.credit_ledger;
create trigger credit_ledger_no_update before update on public.credit_ledger
  for each row execute function public.sl_ledger_no_update();

-- ── credit_requests: manual top-up queue ─────────────────────────────────────
create table if not exists public.credit_requests (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  modality          modality_flag not null,
  minutes           numeric(10,3) not null check (minutes > 0),
  payment_channel   text,          -- how the user paid, outside the software
  payment_reference text,          -- what the user wants the admin to match
  note              text,
  status            text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_id          uuid references public.profiles (id) on delete set null,
  admin_note        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists credit_requests_status_idx on public.credit_requests (status, created_at desc);
create index if not exists credit_requests_user_idx   on public.credit_requests (user_id, created_at desc);

-- A client may only open a pending request; it can never approve its own.
create or replace function public.sl_request_is_pending()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and not public.is_admin(auth.uid()) then
    new.status := 'pending';
    new.admin_id := null;
    new.admin_note := null;
  end if;
  return new;
end; $$;

drop trigger if exists credit_requests_client_defaults on public.credit_requests;
create trigger credit_requests_client_defaults before insert on public.credit_requests
  for each row execute function public.sl_request_is_pending();

drop trigger if exists credit_requests_touch on public.credit_requests;
create trigger credit_requests_touch before update on public.credit_requests
  for each row execute function public.touch_updated_at();

-- Stop one account burying the queue: a few open requests is plenty for a
-- human-readable worklist. Admins are exempt (they file grants directly).
create or replace function public.sl_limit_open_requests()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_open integer;
begin
  if public.is_admin(auth.uid()) then return new; end if;
  select count(*) into v_open from public.credit_requests
  where user_id = new.user_id and status = 'pending' and id <> new.id;
  if v_open >= 3 then
    raise exception 'you already have % credit requests waiting; an administrator will answer them first', v_open;
  end if;
  return new;
end; $$;

drop trigger if exists credit_requests_limit_open on public.credit_requests;
create trigger credit_requests_limit_open before insert on public.credit_requests
  for each row execute function public.sl_limit_open_requests();

-- ── burn rates, versioned per modality ───────────────────────────────────────
create table if not exists public.burn_rates (
  id             serial primary key,
  modality       modality_flag not null,
  multiplier     numeric(6,3) not null,            -- 1 real minute costs N wallet minutes
  effective_from timestamptz not null default now(),
  retired_at     timestamptz,
  note           text,
  created_by     uuid references public.profiles (id) on delete set null
);
create index if not exists burn_rates_lookup_idx on public.burn_rates (modality, effective_from desc);

-- Seed from the old timer_config singletons (video 1.0, audio 0.5, video+audio 1.5).
insert into public.burn_rates (modality, multiplier, note)
select m.modality, m.mult, 'migrated from timer_config'
from (values
  ('video'::modality_flag,      1.000),
  ('audio'::modality_flag,      0.500),
  ('video_audio'::modality_flag, 1.500)
) as m(modality, mult)
where not exists (select 1 from public.burn_rates b where b.modality = m.modality);

create or replace function public.current_burn_rate(p_modality modality_flag)
returns numeric
language sql
stable
as $$
  select coalesce((
    select multiplier from public.burn_rates
    where modality = p_modality and effective_from <= now() and retired_at is null
    order by effective_from desc, id desc
    limit 1
  ), 1.0);
$$;

-- ── app_config: single row of gateway-wide switches ──────────────────────────
create table if not exists public.app_config (
  id                     integer primary key check (id = 1),
  min_supported_version  text    not null default '1.0.0',   -- kill switch for old desktop builds
  latest_version         text,
  signup_enabled         boolean not null default true,
  maintenance            boolean not null default false,
  maintenance_message    text,
  lease_chunk_minutes    numeric(6,3) not null default 5,    -- prepaid per lease window
  lease_ttl_seconds      integer not null default 120,       -- heartbeat must land inside this
  updated_at             timestamptz not null default now()
);

insert into public.app_config (id) values (1) on conflict (id) do nothing;

drop trigger if exists app_config_touch on public.app_config;
create trigger app_config_touch before update on public.app_config
  for each row execute function public.touch_updated_at();

-- ── Key pool: per-provider keys, health + assignment ─────────────────────────
alter table public.gateway_keys
  add column if not exists enabled           boolean not null default true,
  add column if not exists priority          integer not null default 100,
  add column if not exists daily_minute_cap  numeric(10,3),          -- null = uncapped
  add column if not exists minutes_today     numeric(10,3) not null default 0,
  add column if not exists usage_day         date not null default (now() at time zone 'utc')::date,
  add column if not exists last_error        text,
  add column if not exists last_error_at     timestamptz;

-- Which key serves which provider for which account. provider is 'fal' (video
-- pipeline) or 'elevenlabs' (voice pipeline); a video_audio call consumes both.
create table if not exists public.user_key_assignments (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  provider   text not null check (provider in ('fal','elevenlabs')),
  key_id     uuid not null references public.gateway_keys (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, provider)
);

create table if not exists public.key_usage_log (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  key_id     uuid references public.gateway_keys (id) on delete set null,
  provider   text not null,
  user_id    uuid references public.profiles (id) on delete set null,
  outcome    text not null check (outcome in ('ok','fail')),
  status     integer,
  detail     text
);
create index if not exists key_usage_log_created_idx on public.key_usage_log (created_at desc);

-- ── usage_sessions: now a metered lease ───────────────────────────────────────
alter table public.usage_sessions
  add column if not exists modality            modality_flag,
  add column if not exists lease_started_at    timestamptz,   -- window start (billed from here)
  add column if not exists lease_expires_at    timestamptz,   -- heartbeat must arrive before this
  add column if not exists pending_debit       numeric(10,3) not null default 0, -- prepaid, unrefunded
  add column if not exists billed_minutes      numeric(10,3) not null default 0, -- wallet minutes net spent
  add column if not exists real_minutes        numeric(10,3) not null default 0, -- wall-clock minutes
  add column if not exists settled             boolean not null default false,
  add column if not exists multiplier          numeric(6,3);

-- Only the open leases matter for concurrency/reaping.
create index if not exists usage_sessions_open_idx on public.usage_sessions (user_id, lease_expires_at)
  where ended_at is null;

-- Backfill modality for existing rows so history keeps rendering.
update public.usage_sessions set modality = public.modality_for_tab(tab) where modality is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: sl_grant_credits — admin top-up / deduction. Also used to settle a request.
-- ─────────────────────────────────────────────────────────────────────────────
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
  v_balance numeric(10,3);
  v_unlimited boolean;
  v_after numeric(10,3);
begin
  if p_minutes is null or p_modality is null then
    return jsonb_build_object('ok', false, 'error', 'minutes and modality are required');
  end if;

  insert into public.credit_balances (user_id, modality, balance)
  values (p_user, p_modality, 0)
  on conflict (user_id, modality) do nothing;

  select balance, unlimited into v_balance, v_unlimited
  from public.credit_balances
  where user_id = p_user and modality = p_modality
  for update;

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

  return jsonb_build_object('ok', true, 'balance', v_after, 'unlimited', v_unlimited);
end; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: sl_start_session — open a metered lease.
-- Locks the balance row, enforces concurrency, pre-debits one chunk.
-- Device binding and key selection stay in the Edge Function; only money here.
-- ─────────────────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────────────────
-- Internal: bill the open window and refund the unused part of the pre-debit.
-- Called by sl_lease (renew/end) and by the reaper. Caller already locks the row.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_settle_window(p_session public.usage_sessions)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_stop     timestamptz;
  v_real     numeric;
  v_charge   numeric;
  v_refund   numeric;
  v_mult     numeric;
begin
  -- Sessions created before this migration have no bucket row; make sure one
  -- exists so a refund can never be silently dropped.
  insert into public.credit_balances (user_id, modality, balance)
  values (p_session.user_id, p_session.modality, 0)
  on conflict (user_id, modality) do nothing;

  v_mult := coalesce(p_session.multiplier, public.current_burn_rate(p_session.modality));
  -- Never bill past the lease horizon: after it the client had no usable token.
  v_stop := least(now(), coalesce(p_session.lease_expires_at, now()));
  v_real := round(greatest(0, (extract(epoch from (v_stop - coalesce(p_session.lease_started_at, p_session.started_at))) / 60.0))::numeric, 3);
  v_charge := round(least(p_session.pending_debit, v_real * v_mult)::numeric, 3);
  v_refund := round(greatest(0, p_session.pending_debit - v_charge)::numeric, 3);

  if v_refund > 0 and not (select unlimited from public.credit_balances
                           where user_id = p_session.user_id and modality = p_session.modality) then
    update public.credit_balances
       set balance = round((balance + v_refund)::numeric, 3),
           total_spent = greatest(0, total_spent - v_refund),
           updated_at = now()
     where user_id = p_session.user_id and modality = p_session.modality;

    insert into public.credit_ledger
      (user_id, modality, kind, delta, balance_after, reason, session_id)
    values
      (p_session.user_id, p_session.modality, 'release', v_refund,
       (select balance from public.credit_balances where user_id = p_session.user_id and modality = p_session.modality),
       'unused lease refunded', p_session.id);
  end if;

  update public.usage_sessions
     set billed_minutes = billed_minutes + v_charge,
         real_minutes   = real_minutes + v_real,
         minutes        = real_minutes + v_real,      -- legacy display column
         pending_debit  = 0,
         lease_started_at = v_stop
   where id = p_session.id;

  return jsonb_build_object('charged', v_charge, 'refunded', v_refund, 'real_minutes', v_real);
end; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: sl_lease — heartbeat ('renew') bills the elapsed window and pre-debits the
-- next one; 'end' closes the session and refunds everything left.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_lease(p_session_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s    public.usage_sessions;
  r    jsonb;
  v_cfg record;
  v_chunk numeric;
  v_balance numeric;
  v_unlimited boolean;
begin
  if p_action not in ('renew','end') then
    return jsonb_build_object('ok', false, 'error', 'action must be renew or end');
  end if;

  select * into s from public.usage_sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'session not found');
  end if;
  if s.settled or s.ended_at is not null then
    return jsonb_build_object('ok', true, 'ended', true, 'settled', true,
                              'billed_minutes', s.billed_minutes, 'balance', null);
  end if;

  r := public.sl_settle_window(s);

  if p_action = 'end' then
    update public.usage_sessions
       set ended_at = now(), settled = true, lease_expires_at = now(), pending_debit = 0
     where id = p_session_id;
    return r || jsonb_build_object(
      'ok', true, 'ended', true,
      'billed_minutes', (select billed_minutes from public.usage_sessions where id = p_session_id),
      'balance', (select balance from public.credit_balances
                  where user_id = s.user_id and modality = s.modality),
      'modality', s.modality::text);
  end if;

  -- renew: pre-debit the next window
  select * into v_cfg from public.app_config where id = 1;
  v_chunk := v_cfg.lease_chunk_minutes;

  select balance, unlimited into v_balance, v_unlimited
  from public.credit_balances
  where user_id = s.user_id and modality = s.modality
  for update;

  if not v_unlimited then
    if v_balance < 1 then
      update public.usage_sessions
         set ended_at = now(), settled = true, lease_expires_at = now(), pending_debit = 0
       where id = p_session_id;
      return r || jsonb_build_object('ok', false, 'ended', true, 'reason', 'out_of_minutes',
                                     'balance', v_balance, 'modality', s.modality::text);
    end if;
    if v_chunk > v_balance then v_chunk := v_balance; end if;
    update public.credit_balances
       set balance = round((balance - v_chunk)::numeric, 3),
           total_spent = total_spent + v_chunk,
           updated_at = now()
     where user_id = s.user_id and modality = s.modality;
  else
    v_chunk := 0;
  end if;

  update public.usage_sessions
     set pending_debit = v_chunk,
         lease_expires_at = now() + make_interval(secs => v_cfg.lease_ttl_seconds),
         lease_started_at = now()
   where id = p_session_id;

  if v_chunk > 0 then
    insert into public.credit_ledger (user_id, modality, kind, delta, balance_after, reason, session_id)
    values (s.user_id, s.modality, 'debit', -v_chunk,
            (select balance from public.credit_balances where user_id = s.user_id and modality = s.modality),
            'lease renewed', p_session_id);
  end if;

  return r || jsonb_build_object(
    'ok', true, 'ended', false,
    'balance', (select balance from public.credit_balances
                where user_id = s.user_id and modality = s.modality),
    'chunk_minutes', v_chunk,
    'lease_ttl_seconds', v_cfg.lease_ttl_seconds,
    'unlimited', v_unlimited,
    'modality', s.modality::text);
end; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: sl_reap_sessions — close leases that ran past their TTL (crash, quit app,
-- lost network). Refunds the unused pre-debit. p_user null = every account
-- (used by the admin panel's reconcile action).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_reap_sessions(p_user uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.usage_sessions;
  n integer := 0;
begin
  for s in
    select * from public.usage_sessions
    where ended_at is null and not settled
      and lease_expires_at is not null
      and lease_expires_at < now()
      and (p_user is null or user_id = p_user)
    for update
  loop
    update public.usage_sessions
       set ended_at = lease_expires_at, settled = true, pending_debit = 0
     where id = s.id;
    perform public.sl_settle_window(s);
    n := n + 1;
  end loop;
  return n;
end; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: sl_request_status / sl_approve_request — the top-up workflow.
-- Approval credits the bucket and stamps the ledger row with request_id, so the
-- money trail from "user paid X" to "balance grew by Y" is one join.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_resolve_request(
  p_request_id uuid,
  p_approve    boolean,
  p_admin      uuid,
  p_note       text default null,
  p_minutes    numeric default null   -- admin can grant a different amount
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.credit_requests;
  v_grant numeric;
  v_res jsonb;
begin
  select * into v_req from public.credit_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'request not found'); end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already_' || v_req.status);
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

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: sl_account_snapshot — everything the user dashboard and the admin panel
-- need about one account in a single call, so clients never read the key tables.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_account_snapshot(p_user uuid default auth.uid())
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if p_user is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if auth.uid() is not null and auth.uid() <> p_user and not public.is_admin(auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select jsonb_build_object(
    'ok', true,
    'user_id', p_user,
    'status', coalesce((select s.status from public.subscriptions s where s.user_id = p_user), 'none'),
    'plan_id', (select s.plan_id from public.subscriptions s where s.user_id = p_user),
    'modalities', jsonb_build_object(
      'video',       coalesce((select s.video_enabled       from public.subscriptions s where s.user_id = p_user), false),
      'audio',       coalesce((select s.audio_enabled       from public.subscriptions s where s.user_id = p_user), false),
      'video_audio', coalesce((select s.video_audio_enabled from public.subscriptions s where s.user_id = p_user), false)),
    'max_concurrent_sessions', coalesce((select s.max_concurrent_sessions from public.subscriptions s where s.user_id = p_user), 1),
    'wallets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'modality', b.modality::text, 'balance', b.balance, 'unlimited', b.unlimited,
        'total_credited', b.total_credited, 'total_spent', b.total_spent,
        'burn_rate', public.current_burn_rate(b.modality)))
      from public.credit_balances b where b.user_id = p_user), '[]'::jsonb),
    'open_sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.id, 'tab', u.tab, 'device_id', u.device_id, 'started_at', u.started_at,
        'lease_expires_at', u.lease_expires_at, 'real_minutes', u.real_minutes))
      from public.usage_sessions u
      where u.user_id = p_user and u.ended_at is null and u.lease_expires_at > now()), '[]'::jsonb),
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'device_id', d.device_id, 'label', d.label, 'revoked', d.revoked, 'last_seen', d.last_seen))
      from public.devices d where d.user_id = p_user), '[]'::jsonb),
    'app', (select jsonb_build_object('min_supported_version', c.min_supported_version,
                                      'latest_version', c.latest_version,
                                      'maintenance', c.maintenance,
                                      'maintenance_message', c.maintenance_message)
            from public.app_config c where c.id = 1)
  ) into v;
  return v;
end; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.credit_balances     enable row level security;
alter table public.credit_ledger       enable row level security;
alter table public.credit_requests     enable row level security;
alter table public.burn_rates          enable row level security;
alter table public.app_config          enable row level security;
alter table public.user_key_assignments enable row level security;
alter table public.key_usage_log       enable row level security;

-- Balances: the owner and admins may read; only the gateway functions write.
drop policy if exists balances_select on public.credit_balances;
create policy balances_select on public.credit_balances
  for select using (auth.uid() = user_id or public.is_admin(auth.uid()));

-- Ledger: read-only history for the owner and admins.
drop policy if exists ledger_select on public.credit_ledger;
create policy ledger_select on public.credit_ledger
  for select using (auth.uid() = user_id or public.is_admin(auth.uid()));

-- Requests: owner reads/creates, admin reads all and updates.
drop policy if exists requests_select on public.credit_requests;
create policy requests_select on public.credit_requests
  for select using (auth.uid() = user_id or public.is_admin(auth.uid()));
drop policy if exists requests_insert on public.credit_requests;
create policy requests_insert on public.credit_requests
  for insert with check (auth.uid() = user_id);
drop policy if exists requests_admin_update on public.credit_requests;
create policy requests_admin_update on public.credit_requests
  for update using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- Burn rates: any signed-in user can see what a minute costs (transparency, no risk).
drop policy if exists rates_select on public.burn_rates;
create policy rates_select on public.burn_rates for select using (auth.role() = 'authenticated');
drop policy if exists rates_admin_write on public.burn_rates;
create policy rates_admin_write on public.burn_rates
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- app_config: readable (the desktop app needs min_supported_version), admin-writable.
drop policy if exists appconfig_select on public.app_config;
create policy appconfig_select on public.app_config for select using (true);
drop policy if exists appconfig_admin_write on public.app_config;
create policy appconfig_admin_write on public.app_config
  for update using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- Key assignments and usage log: admins only — a regular user must not learn
-- which key serves them.
drop policy if exists uka_admin on public.user_key_assignments;
create policy uka_admin on public.user_key_assignments
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
drop policy if exists kul_admin_select on public.key_usage_log;
create policy kul_admin_select on public.key_usage_log
  for select using (public.is_admin(auth.uid()));

-- Sessions: admins may close/see everything; the owner already has select.
drop policy if exists usage_admin_all on public.usage_sessions;
create policy usage_admin_all on public.usage_sessions
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- ── Only the service role may call the money functions ───────────────────────
revoke execute on function
  public.sl_grant_credits(uuid, modality_flag, numeric, text, uuid, uuid, boolean),
  public.sl_start_session(uuid, modality_flag, text, text),
  public.sl_lease(uuid, text),
  public.sl_reap_sessions(uuid),
  public.sl_resolve_request(uuid, boolean, uuid, text, numeric),
  public.sl_settle_window(public.usage_sessions),
  public.sl_account_snapshot(uuid)
from public, anon, authenticated;

grant execute on function
  public.sl_grant_credits(uuid, modality_flag, numeric, text, uuid, uuid, boolean),
  public.sl_start_session(uuid, modality_flag, text, text),
  public.sl_lease(uuid, text),
  public.sl_reap_sessions(uuid),
  public.sl_resolve_request(uuid, boolean, uuid, text, numeric),
  public.sl_settle_window(public.usage_sessions)
to service_role;

-- sl_account_snapshot is meant for clients (it self-checks auth.uid()).
grant execute on function public.sl_account_snapshot(uuid) to authenticated;

-- ── Admin housekeeping views ─────────────────────────────────────────────────
-- security_invoker = true so the underlying RLS still applies: an admin sees
-- everything, a regular user sees only their own rows (and never key values).
create or replace view public.admin_live_sessions
with (security_invoker = true) as
select u.id, u.user_id, p.email, u.tab, u.modality, u.device_id, u.started_at,
       u.lease_started_at, u.lease_expires_at, u.real_minutes, u.billed_minutes,
       u.pending_debit, u.multiplier
from public.usage_sessions u
join public.profiles p on p.id = u.user_id
where u.ended_at is null;

create or replace view public.admin_key_health
with (security_invoker = true) as
select k.id, k.label, k.enabled, k.priority, k.daily_minute_cap, k.minutes_today, k.usage_day,
       k.last_error, k.last_error_at,
       coalesce(l.fails, 0) as recent_failures
from public.gateway_keys k
left join (
  select key_id, count(*) as fails
  from public.key_usage_log
  where outcome = 'fail' and created_at > now() - interval '24 hours'
  group by key_id
) l on l.key_id = k.id;

grant select on public.admin_live_sessions, public.admin_key_health to authenticated;

-- ── Legacy helper, retargeted at the new wallets ──────────────────────────────
-- has_entitlement() predates the bucket model (it read plans.monthly_minutes and
-- subscriptions.minutes_used). Rewrite it so any old caller still gets a sane
-- answer: the account is entitled to a feature if that modality is enabled and
-- its bucket is unlimited or still has at least one minute.
create or replace function public.has_entitlement(p_user uuid, p_feature feature_flag)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.subscriptions s
    join public.credit_balances b
      on b.user_id = s.user_id
     and b.modality = (case p_feature
                         when 'voice' then 'audio'::modality_flag
                         else 'video'::modality_flag end)
    where s.user_id = p_user
      and s.status = 'active'
      and (b.unlimited or b.balance >= 1)
      and case p_feature
            when 'voice'  then s.audio_enabled
            when 'video'  then s.video_enabled
            else s.video_enabled
          end
  );
$$;

-- ── Explicit table rights (Supabase grants these by default; stated so the
--    contract survives a project restore onto a cluster without those defaults).
--    RLS above is what actually decides visibility.
grant select  on public.credit_balances, public.credit_ledger, public.burn_rates, public.app_config
  to authenticated;
grant select, insert, update on public.credit_requests to authenticated;

-- timer_config and billing_config (20261002) are superseded: burn rates now live in
-- burn_rates per modality, and cost/profit maths is an admin-panel concern, not a
-- gateway one. They are left in place so nothing that still reads them breaks.

-- ── Signup switch, enforced server-side ──────────────────────────────────────
-- Self-signup stays open (product decision), but the admin must be able to shut
-- the door without touching the dashboard. GoTrue inserts the auth.users row, so a
-- BEFORE INSERT trigger is the only place that can refuse it. Email confirmation
-- stays OFF: the row must appear immediately either way.
create or replace function public.sl_guard_signup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.app_config where id = 1 and signup_enabled = false) then
    raise exception 'account creation is temporarily disabled';
  end if;
  return new;
end; $$;

drop trigger if exists sl_guard_signup on auth.users;
create trigger sl_guard_signup before insert on auth.users
  for each row execute function public.sl_guard_signup();

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: key pool. A gateway_keys row is a (fal, elevenlabs) pair; provider picks
-- which half is used. sl_pick_keys returns every usable key for an account in
-- the order the caller should try them, so failover is a loop, not a special case.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_pick_keys(p_user uuid, p_provider text)
returns table (key_id uuid, label text, secret text, priority integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select k.id, k.label,
           case when p_provider = 'fal' then k.fal_key else k.elevenlabs_key end as secret,
           k.priority, k.enabled, k.daily_minute_cap,
           -- day rollover is applied at read time so a stale counter can never
           -- lock an account out of a healthy key
           case when k.usage_day < (now() at time zone 'utc')::date then 0 else k.minutes_today end as used_today,
           -- explicitly assigned (new table, or the legacy per-subscription key)
           case when a.key_id is not null or k.id = s.key_id then 0 else 1 end as assign_rank,
           case when k.is_default then 0 else 1 end as default_rank,
           k.created_at
    from public.gateway_keys k
    left join public.user_key_assignments a
      on a.key_id = k.id and a.user_id = p_user and a.provider = p_provider
    left join public.subscriptions s on s.user_id = p_user
    where k.enabled
      and (p_provider <> 'fal'     or k.fal_key        is not null)
      and (p_provider <> 'elevenlabs' or k.elevenlabs_key is not null)
  )
  select id, label, secret, priority
  from candidates
  where secret is not null and secret <> ''
    and (daily_minute_cap is null or used_today < daily_minute_cap)
  order by assign_rank, default_rank, priority asc nulls last, created_at asc;
$$;

-- Bookkeeping after an upstream attempt: minutes burned against the key (daily cap)
-- plus the outcome. A failure records last_error for the panel; a success clears it.
-- Failover itself is just "try the next row sl_pick_keys returned".
create or replace function public.sl_report_key_use(
  p_key_id   uuid,
  p_provider text,
  p_user     uuid,
  p_outcome  text,
  p_minutes  numeric default 0,
  p_status   integer default null,
  p_detail   text    default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
begin
  insert into public.key_usage_log (key_id, provider, user_id, outcome, status, detail)
  values (p_key_id, p_provider, p_user, p_outcome, p_status, left(coalesce(p_detail, ''), 400));

  if p_key_id is null then return; end if;

  update public.gateway_keys
     set minutes_today = case when usage_day < v_today then greatest(0, p_minutes)
                              else minutes_today + greatest(0, p_minutes) end,
         usage_day     = v_today,
         last_error    = case when p_outcome = 'fail' then left(coalesce(p_detail, ''), 400) else null end,
         last_error_at = case when p_outcome = 'fail' then now() else last_error_at end
   where id = p_key_id;
end; $$;

-- RPC: sign a user out of every device by dropping their auth sessions. Used by
-- "sign out everywhere" in the admin panel (e.g. after a shared account is sold on).
create or replace function public.sl_sign_out_everywhere(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  update auth.sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  get diagnostics n = row_count;
  -- refresh_tokens exists on GoTrue v2 but not every deployment; never fail the
  -- sign-out over it, sessions alone already invalidate the tokens.
  begin
    delete from auth.refresh_tokens where user_id = p_user;
  exception when undefined_table then null;
  end;
  return n;
end; $$;

-- ── Key pool RPCs: service role only. sl_pick_keys hands out raw key material,
--    so a client JWT must never be able to call it. Supabase's default privileges
--    grant new public functions to anon/authenticated, hence the explicit revoke.
revoke execute on function
  public.sl_pick_keys(uuid, text),
  public.sl_report_key_use(uuid, text, uuid, text, numeric, integer, text),
  public.sl_sign_out_everywhere(uuid),
  public.sl_guard_signup()
from public, anon, authenticated;

grant execute on function
  public.sl_pick_keys(uuid, text),
  public.sl_report_key_use(uuid, text, uuid, text, numeric, integer, text),
  public.sl_sign_out_everywhere(uuid)
to service_role;
