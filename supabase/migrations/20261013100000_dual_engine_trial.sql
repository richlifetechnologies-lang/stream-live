-- Dual engine: a free 1-minute trial served by Decart, paid minutes served by fal.
--
-- What this closes and what it opens:
--   * a brand new account gets 1 video minute at sign-up and is served by the
--     Decart key pool, so trial traffic costs the fal balance nothing;
--   * the first paid or admin-granted minute flips that account to fal for good;
--   * the engine is decided inside the gateway on every Start and stamped on the
--     lease, so what is billed, what is capped and what is shown can never drift;
--   * a Decart failure never falls through to fal. It refuses.
--
-- Additive only: no existing column is re-typed or dropped, so live wallets,
-- leases and keys are untouched. Safe to run more than once.

-- -- 1. app_config: the trial knobs, all off by default -----------------------
alter table public.app_config
  add column if not exists trial_enabled boolean not null default false,
  add column if not exists trial_video_minutes numeric(6,3) not null default 1.000,
  add column if not exists max_concurrent_trial_sessions integer,
  add column if not exists allow_fal_when_no_decart boolean not null default false;

comment on column public.app_config.trial_enabled is
  'Master switch for the free trial. false = no account is ever granted trial minutes and nothing here changes behaviour.';

comment on column public.app_config.trial_video_minutes is
  'Wallet minutes granted to a brand new account. Video only; voice is never part of the trial.';

comment on column public.app_config.max_concurrent_trial_sessions is
  'How many trial (Decart) leases may be live at once across all accounts. null or 0 = uncapped.';

comment on column public.app_config.allow_fal_when_no_decart is
  'true = when every Decart key is used up, a trial account falls back to fal and spends the fal balance. Default false, which refuses the trial instead. Only turn this on deliberately.';

-- -- 2. gateway_keys: a third provider, with a budget per key ----------------
-- A Decart key is a finite pot of trial minutes (1,000 credits is about 8 minutes
-- at the standard rate). The budget is tracked here, locally, so the gateway can
-- move to the next key automatically and the panel can show what is left without
-- ever asking Decart for a balance.
alter table public.gateway_keys
  add column if not exists decart_key          text,
  add column if not exists trial_minutes_budget numeric(10,3),
  add column if not exists trial_minutes_used   numeric(10,3) not null default 0;

comment on column public.gateway_keys.trial_minutes_budget is
  'Trial minutes this Decart key can serve before it is skipped. null = uncapped. Does not roll over per day.';

-- Assignments could only ever name fal or elevenlabs. Widening that check is what
-- lets the panel point one account at one specific Decart key; nothing assigned
-- today is touched, because an existing row's provider value still passes.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'user_key_assignments_provider_check'
      and conrelid = 'public.user_key_assignments'::regclass
  ) then
    alter table public.user_key_assignments
      drop constraint user_key_assignments_provider_check;
  end if;
  alter table public.user_key_assignments
    add constraint user_key_assignments_provider_check
    check (provider in ('fal', 'elevenlabs', 'decart'));
end; $$;

-- -- 3. usage_sessions: the engine that served each lease ---------------------
alter table public.usage_sessions
  add column if not exists engine text not null default 'fal'
    check (engine in ('fal', 'decart'));

-- Which Decart key paid for this lease, so the minute the customer never streamed
-- can go back to that same key instead of staying spent forever.
alter table public.usage_sessions
  add column if not exists decart_key_id uuid references public.gateway_keys (id) on delete set null;

create index if not exists usage_sessions_engine_live_idx
  on public.usage_sessions (engine, lease_expires_at desc)
  where ended_at is null;

-- -- 4. subscriptions: the admin pin and the once-per-account stamp ----------
alter table public.subscriptions
  add column if not exists engine_override text
    check (engine_override in ('fal', 'decart')),
  add column if not exists engine_override_by uuid,
  add column if not exists engine_override_at timestamptz,
  add column if not exists trial_granted_at timestamptz;

comment on column public.subscriptions.engine_override is
  'null = follow the rule (paid goes to fal, trial-only goes to Decart). A paid account cannot be pinned to decart; that direction is one way.';

comment on column public.subscriptions.engine_override_by is
  'which admin set the pin, and when. Cleared with the pin, so the panel never shows a stale owner.';

-- -- 5. One test decides the engine, forever ---------------------------------
-- "Paid" means any wallet credit this account ever received that was not the free
-- trial. It is monotonic on purpose: an account that has been given minutes once
-- is served by fal from then on, even if its balance later drops to zero.
create or replace function public.sl_account_is_paid(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
           select 1 from public.credit_ledger l
           where l.user_id = p_user
             and l.kind = 'credit'
             and coalesce(l.reason, '') <> 'free trial'
         )
      or exists (
           select 1 from public.credit_balances b
           where b.user_id = p_user and b.unlimited
         );
$$;

-- -- 6. Trial capacity left in the Decart pool -------------------------------
-- Locally tracked counters only. Nothing here calls Decart.
create or replace function public.sl_trial_supply()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'keys_ready',          count(*),
    'minutes_remaining',   coalesce(sum(case when k.trial_minutes_budget is null
                                             then null
                                             else greatest(k.trial_minutes_budget - k.trial_minutes_used, 0)
                                        end), 0),
    'uncapped_keys',       count(*) filter (where k.trial_minutes_budget is null)
  )
  from public.gateway_keys k
  where k.enabled
    and coalesce(k.decart_key, '') <> ''
    and (k.trial_minutes_budget is null or k.trial_minutes_used < k.trial_minutes_budget);
$$;

-- -- 7. Key pool: Decart is now a provider, and budget gates eligibility -----
-- Same shape as before: assigned keys first, then default, then cheapest priority,
-- then any key that is enabled, holds a secret for this provider, is under its
-- daily cap, and (for Decart) still has trial minutes left.
create or replace function public.sl_pick_keys(p_user uuid, p_provider text)
returns table (key_id uuid, label text, secret text, priority integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select k.id, k.label,
           k.priority, k.enabled, k.daily_minute_cap, k.trial_minutes_budget, k.trial_minutes_used,
           case when p_provider = 'fal'     then k.fal_key
                when p_provider = 'decart'  then k.decart_key
                else k.elevenlabs_key end as secret,
           case when k.usage_day < (now() at time zone 'utc')::date then 0 else k.minutes_today end as used_today,
           case when a.key_id is not null or k.id = s.key_id then 0 else 1 end as assign_rank,
           case when k.is_default then 0 else 1 end as default_rank,
           k.created_at
    from public.gateway_keys k
    left join public.user_key_assignments a
      on a.key_id = k.id and a.user_id = p_user and a.provider = p_provider
    left join public.subscriptions s on s.user_id = p_user
    where k.enabled
      and (p_provider <> 'fal'         or k.fal_key        is not null)
      and (p_provider <> 'elevenlabs'  or k.elevenlabs_key is not null)
      and (p_provider <> 'decart'      or coalesce(k.decart_key, '') <> '')
  )
  select id, label, secret, priority
  from candidates
  where secret is not null and secret <> ''
    and (daily_minute_cap is null or used_today < daily_minute_cap)
    and (p_provider <> 'decart' or trial_minutes_budget is null or trial_minutes_used < trial_minutes_budget)
  order by assign_rank, default_rank, priority asc nulls last, created_at asc;
$$;

-- Book the trial minutes a Decart key just committed to, and remember which key paid
-- for the lease. Called after a successful mint, never before, so a key that failed
-- to answer is not charged for it.
create or replace function public.sl_book_decart_minutes(
  p_key_id     uuid,
  p_minutes    numeric,
  p_session_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.gateway_keys
     set trial_minutes_used = round(greatest(0, trial_minutes_used + coalesce(p_minutes, 0))::numeric, 3)
   where id = p_key_id
     and coalesce(decart_key, '') <> '';

  if p_session_id is not null then
    update public.usage_sessions set decart_key_id = p_key_id where id = p_session_id;
  end if;
end; $$;

-- Hand back the part of a prepaid trial chunk nobody streamed. Decart bills per
-- second of real generation, so a customer who stops after ten seconds used ten
-- seconds of the key, not the whole minute. Without this, every early stop would
-- burn key budget the account was refunded and the pool would empty far ahead of
-- the credits actually bought.
create or replace function public.sl_release_decart_minutes(p_key_id uuid, p_minutes numeric)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.gateway_keys
     set trial_minutes_used = round(greatest(0, trial_minutes_used - coalesce(p_minutes, 0))::numeric, 3)
   where id = p_key_id
     and coalesce(decart_key, '') <> '';
$$;

-- -- 7b. The window settle now also settles the key it ran on ----------------
-- Same function, same signature, one extra duty: the refund that goes back to the
-- wallet goes back to the Decart key too. Called by sl_lease (renew/end) and by the
-- reaper, both of which already hold the session row lock.
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
  insert into public.credit_balances (user_id, modality, balance)
  values (p_session.user_id, p_session.modality, 0)
  on conflict (user_id, modality) do nothing;

  v_mult := coalesce(p_session.multiplier, public.current_burn_rate(p_session.modality));
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

  if v_refund > 0 and p_session.engine = 'decart' and p_session.decart_key_id is not null then
    perform public.sl_release_decart_minutes(p_session.decart_key_id, v_refund);
  end if;

  update public.usage_sessions
     set billed_minutes = billed_minutes + v_charge,
         real_minutes   = real_minutes + v_real,
         minutes        = real_minutes + v_real,
         pending_debit  = 0,
         lease_started_at = v_stop
   where id = p_session.id;

  return jsonb_build_object('charged', v_charge, 'refunded', v_refund, 'real_minutes', v_real);
end; $$;

-- -- 7c. The renewal has to know which engine it is renewing ------------------
-- Two things go wrong if it does not, and both cost real money.
--
-- The cut-off. Renewal demands a whole minute on hand, but a trial's only minute
-- was already pre-debited as the opening chunk, so at the first heartbeat (~45 s)
-- the balance reads 0, this gate ends the lease, and the promised minute of video
-- quietly becomes 45 seconds. A trial renews on anything above zero, which is the
-- same split sl_start_session makes when it decides whether to let the call start.
--
-- The bookkeeping. A renewal that pre-debits another chunk must charge it to the
-- Decart key serving the session, or that key's budget under-counts and a pool that
-- is already empty keeps getting picked. sl_settle_window hands the unused part back
-- to the same key, so booking here is what makes the two numbers agree.
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
  v_min_start numeric;
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

  v_min_start := case when s.engine = 'decart' then 0.001 else 1 end;

  if not v_unlimited then
    if v_balance < v_min_start then
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

  if v_chunk > 0 and s.engine = 'decart' and s.decart_key_id is not null then
    perform public.sl_book_decart_minutes(s.decart_key_id, v_chunk, p_session_id);
  end if;

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

-- -- 8. sl_start_session: decide the engine, then meter as before ------------
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
  v_sub       record;
  v_enabled   boolean;
  v_balance   numeric(10,3);
  v_unlimited boolean;
  v_cfg       record;
  v_open      integer;
  v_video_open integer;
  v_trial_open integer;
  v_ready     integer;
  v_engine    text;
  v_chunk     numeric(10,3);
  v_min_start numeric(10,3);
  v_session   uuid;
  v_mult      numeric(6,3);
begin
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

  -- The wallet gate itself sits below, after the engine is known: how much a
  -- session needs on hand depends on which engine it runs on.
  -- Concurrency inside the account, exactly as before.
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

  -- ENGINE ---------------------------------------------------------------------
  -- The pin wins, unless it is impossible. Paid always means fal: a stale or
  -- hand-edited 'decart' pin on a paid account is corrected here rather than
  -- trusted, because the product rule is one way only.
  --
  -- The default is NOT "everyone who is not paid". It is "everyone who actually
  -- holds a granted free trial", which only the sign-up trigger ever stamps. An
  -- account that predates the trial, and an admin account, were never promised a
  -- free minute, so they are served by the paid service like always - otherwise
  -- switching the trial on would silently move existing customers and the main
  -- admin login onto trial keys.
  v_engine := v_sub.engine_override;
  if public.sl_account_is_paid(p_user) then
    v_engine := 'fal';
  elsif v_engine is null then
    if v_sub.trial_granted_at is not null and not public.is_admin(p_user) then
      v_engine := 'decart';
    else
      v_engine := 'fal';
    end if;
  end if;

  -- Voice has no Decart path. Anything that is not plain video is fal.
  if p_modality <> 'video' then v_engine := 'fal'; end if;

  if v_engine = 'decart' then
    select count(*) into v_trial_open
    from public.usage_sessions
    where ended_at is null
      and lease_expires_at > now()
      and engine = 'decart';
    if coalesce(v_cfg.max_concurrent_trial_sessions, 0) > 0
       and v_trial_open >= v_cfg.max_concurrent_trial_sessions then
      return jsonb_build_object('allowed', false, 'reason', 'lines_busy',
                                'engine', 'decart',
                                'open_trial_sessions', v_trial_open,
                                'max_concurrent_trial_sessions', v_cfg.max_concurrent_trial_sessions);
    end if;

    select count(*) into v_ready
    from public.gateway_keys k
    where k.enabled
      and coalesce(k.decart_key, '') <> ''
      and (k.trial_minutes_budget is null or k.trial_minutes_used < k.trial_minutes_budget);
    if v_ready = 0 then
      if coalesce(v_cfg.allow_fal_when_no_decart, false) then
        v_engine := 'fal';
      else
        -- Deliberate: this is the branch that protects the fal balance. The user
        -- hears "lines are busy"; nothing is debited and no fal key is touched.
        return jsonb_build_object('allowed', false, 'reason', 'lines_busy',
                                  'engine', 'decart',
                                  'detail', 'no trial capacity in the key pool');
      end if;
    end if;
  end if;

  -- Wallet gate, once the engine is final.
  --
  -- A paid session needs a whole minute on hand: it pre-debits a 5-minute chunk and
  -- renews against the rest. A trial does not, because its chunk is already capped
  -- at whatever the wallet holds. Without the split, someone who streams 12 seconds
  -- of their free minute and stops would be left with 0:48 that the gate below 1
  -- minute refuses to start, and the part of the trial nobody used would be
  -- stranded. Anything above zero is spendable on a trial.
  if not v_unlimited then
    v_min_start := case when v_engine = 'decart' then 0.001 else 1 end;
    if v_balance < v_min_start then
      return jsonb_build_object('allowed', false, 'reason', 'out_of_minutes',
                                'balance', v_balance, 'modality', p_modality::text);
    end if;
    if v_chunk > v_balance then v_chunk := v_balance; end if;
  else
    v_chunk := 0;
  end if;

  -- A free trial burns at wall-clock parity: one credited minute is exactly sixty
  -- seconds of video, whatever burn_rates.video says. Raising the paid rate for
  -- margin must never be able to shrink a trial underneath the minute it promised.
  if v_engine = 'decart' then v_mult := 1.000; end if;

  -- Workspace ceiling on fal, unchanged, but now only for sessions that will
  -- actually use fal.
  if coalesce(v_cfg.max_concurrent_video_sessions, 0) > 0
     and v_engine = 'fal'
     and p_modality in ('video', 'video_audio') then
    select count(*) into v_video_open
    from public.usage_sessions
    where ended_at is null
      and lease_expires_at > now()
      and modality in ('video', 'video_audio')
      and engine = 'fal';
    if v_video_open >= v_cfg.max_concurrent_video_sessions then
      return jsonb_build_object('allowed', false, 'reason', 'lines_busy',
                                'engine', 'fal',
                                'open_video_sessions', v_video_open,
                                'max_concurrent_video_sessions', v_cfg.max_concurrent_video_sessions);
    end if;
  end if;

  insert into public.usage_sessions
    (user_id, device_id, tab, modality, feature, started_at,
     lease_started_at, lease_expires_at, pending_debit, multiplier, engine)
  values
    (p_user, p_device, p_tab, p_modality,
     case p_modality when 'audio' then 'voice'::feature_flag else 'video'::feature_flag end,
     now(), now(),
     now() + make_interval(secs => v_cfg.lease_ttl_seconds),
     v_chunk, v_mult, v_engine)
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
    'engine', v_engine,
    'modality', p_modality::text,
    'chunk_minutes', v_chunk,
    'lease_ttl_seconds', v_cfg.lease_ttl_seconds,
    'multiplier', v_mult,
    'unlimited', v_unlimited,
    'balance', (select balance from public.credit_balances where user_id = p_user and modality = p_modality)
  );
end; $$;

-- -- 9. The admin pin, enforced in the database rather than in the page ------
create or replace function public.sl_set_engine_override(
  p_user   uuid,
  p_engine text,
  p_actor  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_engine is not null and p_engine not in ('fal', 'decart') then
    return jsonb_build_object('ok', false, 'error', 'engine must be fal, decart, or null to clear the pin');
  end if;

  if not exists (select 1 from public.profiles where id = p_user) then
    return jsonb_build_object('ok', false, 'error', 'no such account');
  end if;

  -- The one-way door: minutes bought or granted cannot be moved back onto the
  -- trial pool, whatever the panel is asked to save.
  if p_engine = 'decart' and public.sl_account_is_paid(p_user) then
    return jsonb_build_object('ok', false,
      'error', 'this account has been credited minutes, so it runs on the paid service. Clear the pin to follow the normal rule.');
  end if;

  update public.subscriptions
     set engine_override    = p_engine,
         engine_override_by = case when p_engine is null then null else p_actor end,
         engine_override_at = case when p_engine is null then null else now() end
   where user_id = p_user;

  return jsonb_build_object('ok', true, 'engine_override', p_engine,
                            'effective', case when p_engine is null then 'automatic' else p_engine end);
end; $$;

-- -- 10. Trial granted at sign-up (2a) ---------------------------------------
-- The minute is in the wallet before the user presses anything, so the Minutes
-- page reads 1:00 on their first open. This runs inside the trigger that already
-- provisions every new account, and it writes the ledger row directly rather than
-- calling sl_grant_credits: that function dedupes identical grants within 15
-- seconds, which is right for an admin double-clicking but would silently reject
-- two people signing up in the same minute.
create or replace function public.sl_provision_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan    text;
  v_minutes numeric(6,3);
  v_after   numeric(10,3);
begin
  v_plan := coalesce(
    (select id from public.plans where id = 'starter'),
    (select min(id) from public.plans where active),
    (select min(id) from public.plans));
  if v_plan is null then return new; end if;   -- plans not configured yet

  insert into public.subscriptions (user_id, plan_id, status)
  values (new.id, v_plan, 'active')
  on conflict (user_id) do nothing;

  select trial_video_minutes into v_minutes from public.app_config where id = 1;
  if not coalesce((select trial_enabled from public.app_config where id = 1), false)
     or v_minutes is null or v_minutes <= 0 then
    return new;
  end if;

  if exists (select 1 from public.credit_ledger
             where user_id = new.id and coalesce(reason, '') = 'free trial') then
    return new;
  end if;

  insert into public.credit_balances (user_id, modality, balance)
  values (new.id, 'video', v_minutes)
  on conflict (user_id, modality) do update
     set balance        = round((credit_balances.balance + v_minutes)::numeric, 3),
         total_credited = credit_balances.total_credited + v_minutes,
         updated_at     = now()
  returning balance into v_after;

  insert into public.credit_ledger
    (user_id, modality, kind, delta, balance_after, reason, actor_id)
  values
    (new.id, 'video', 'credit', v_minutes, v_after, 'free trial', null);

  update public.subscriptions
     set trial_granted_at = now()
   where user_id = new.id;

  return new;
end; $$;

-- Existing accounts are deliberately NOT backfilled: the trial is for accounts
-- created after trial_enabled is switched on, and an old zero-balance account
-- still meets 'out_of_minutes' before it can ever reach a Decart key.

-- -- 11. Admin views: show the engine, and the Decart side of the pool -------
create or replace view public.admin_live_sessions
with (security_invoker = true) as
select u.id, u.user_id, p.email, u.tab, u.modality, u.device_id, u.started_at,
       u.lease_started_at, u.lease_expires_at, u.real_minutes, u.billed_minutes,
       u.pending_debit, u.multiplier, u.engine, u.decart_key_id
from public.usage_sessions u
join public.profiles p on p.id = u.user_id
where u.ended_at is null;

create or replace view public.admin_key_health
with (security_invoker = true) as
select k.id, k.label, k.enabled, k.priority, k.daily_minute_cap, k.minutes_today, k.usage_day,
       k.last_error, k.last_error_at, k.is_default, k.created_at,
       k.trial_minutes_budget, k.trial_minutes_used,
       public.sl_key_tail(nullif(k.fal_key, ''))        as video_key_tail,
       public.sl_key_tail(nullif(k.elevenlabs_key, '')) as voice_key_tail,
       public.sl_key_tail(nullif(k.decart_key, ''))     as trial_key_tail,
       coalesce(l.fails, 0) as recent_failures
from public.gateway_keys k
left join (
  select key_id, count(*) as fails
  from public.key_usage_log
  where outcome = 'fail' and created_at > now() - interval '24 hours'
  group by key_id
) l on l.key_id = k.id;

grant select on public.admin_live_sessions, public.admin_key_health to authenticated;

-- -- 12. Execute rights -------------------------------------------------------
-- Postgres hands EXECUTE on a brand-new function to PUBLIC, which for Supabase
-- means any signed-in account. These four describe the inside of the key pool and
-- move money inside it, so they are closed to clients before anything is granted.
revoke execute on function
  public.sl_trial_supply(),
  public.sl_book_decart_minutes(uuid, numeric, uuid),
  public.sl_release_decart_minutes(uuid, numeric),
  public.sl_set_engine_override(uuid, text, uuid)
from public, anon, authenticated;

grant execute on function public.sl_account_is_paid(uuid)              to authenticated, service_role;
grant execute on function public.sl_trial_supply()                    to service_role;
grant execute on function public.sl_book_decart_minutes(uuid, numeric, uuid) to service_role;
grant execute on function public.sl_release_decart_minutes(uuid, numeric) to service_role;
grant execute on function public.sl_set_engine_override(uuid, text, uuid) to service_role;
grant execute on function public.sl_pick_keys(uuid, text)             to service_role;
