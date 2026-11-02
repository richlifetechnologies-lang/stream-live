-- One pool of minutes funds both tabs, and the cloning door is bolted from both sides -----------
--
-- Three things this file does, and one it deliberately does not.
--
-- 1. ONE POOL. A Video + Audio call has always been stamped as its own modality, so the meter could
--    price it above a plain video call. But the minutes it had to spend came from a second wallet
--    that nothing on the shelf sells: every package on the shelf credits video minutes, and the
--    video_audio bucket has never had a price attached to it. The tab customers asked for most was
--    therefore unreachable except by an administrator hand-posting minutes into a bucket he could
--    not buy. From here the tab's OWN modality still sets the rate, and the minutes come out of the
--    one pool the account actually holds. No rate is invented and no price moves: the multiplier the
--    administrator sets on the Burn rates tab is still read for the session's own modality.
--
-- 2. THE MAP IS ONE FUNCTION, NOT TWENTY. `sl_pay_bucket` answers which wallet a modality spends
--    from. Every place that touched a wallet now asks it, so a second tab with its own bucket later
--    is one function to edit instead of an audit. The session row, the ledger's history and the
--    panel's call records all keep their own modality - only the wallet moves.
--
-- 3. THE PAID-ACCOUNT RULE FOR CLONING. Cloning has no free path: a non-video modality is forced
--    onto the paid video engine, so a granted trial minute would buy a real paid video call AND a
--    paid voice call off the workspace keys, billed to nobody. Trial minutes now refuse the cloning
--    tab at the gate, with their own reason so the app can say it plainly instead of "out of
--    minutes".
--
-- 4. WHAT THIS FILE DOES NOT DO: it does not retire the video_audio bucket from the enum, the
--    packages, the burn-rate table or the ledger. The rows stay where the history is, folded into
--    the pool below so no customer loses a minute he was granted. And it does not touch the money
--    maths: a window is still charged from the first frame, still capped at the pre-paid chunk, and
--    still gives back whatever it did not use.
--
-- The bodies of sl_lease, sl_start_session, sl_settle_window, sl_grant_credits and
-- sl_take_back_minutes below are the live text copied out of the newest migration that defined
-- them, with only the mapping, the fold and the paid-account gate applied. Nothing else was
-- rewritten: a money function re-typed from memory is how a clause gets lost.
--   sl_start_session / sl_lease      <- 20261028220000_a_renewed_lease_says_what_it_took.sql
--   sl_settle_window                 <- 20261015100000_key_usage_live.sql
--   sl_grant_credits                 <- 20261012090000_lease_guards_and_grant_safety.sql
--   sl_take_back_minutes             <- 20261022210200_money_that_goes_back_takes_its_minutes_back.sql
--   sl_account_snapshot              <- 20261013233000_snapshot_paid_flag.sql

-- -- 1. Which wallet a modality spends from -------------------------------------------------
create or replace function public.sl_pay_bucket(p_modality modality_flag)
returns modality_flag
language sql
immutable
as $$
  select case when p_modality = 'video_audio' then 'video'::modality_flag else p_modality end;
$$;

comment on function public.sl_pay_bucket(modality_flag) is
  'The bucket a call actually spends minutes from. A Video + Audio call pays from the one pool; its '
  'own modality still decides the rate. Nothing else maps modalities to wallets.';

revoke execute on function public.sl_pay_bucket(modality_flag) from anon;
grant execute on function public.sl_pay_bucket(modality_flag) to authenticated, service_role;

-- -- 2. Fold what the old second wallet held into the pool -----------------------------------
-- Nobody loses a minute: whatever a video_audio bucket held is carried to that account's video
-- bucket, its lifetime credit and spend figures travel with it, and the move is written to the
-- ledger with its own reason so the audit trail shows why the number arrived. The source row is
-- zeroed rather than deleted - the ledger and past sessions still name that modality, and a zero
-- row harms nothing.
do $$
declare
  v_src record;
  v_new numeric(10,3);
begin
  for v_src in
    select * from public.credit_balances
     where modality = 'video_audio'
       and (coalesce(balance, 0) > 0 or coalesce(unlimited, false))
     for update
  loop
    insert into public.credit_balances (user_id, modality, balance)
    values (v_src.user_id, 'video', 0)
    on conflict (user_id, modality) do nothing;

    update public.credit_balances
       set balance        = round((coalesce(balance, 0) + coalesce(v_src.balance, 0))::numeric, 3),
           total_credited = total_credited + coalesce(v_src.total_credited, 0),
           total_spent    = total_spent + coalesce(v_src.total_spent, 0),
           unlimited      = coalesce(unlimited, false) or coalesce(v_src.unlimited, false),
           updated_at     = now()
     where user_id = v_src.user_id and modality = 'video';

    select balance into v_new from public.credit_balances
     where user_id = v_src.user_id and modality = 'video';

    insert into public.credit_ledger (user_id, modality, kind, delta, balance_after, reason)
    values (v_src.user_id, 'video', 'credit', round(coalesce(v_src.balance, 0), 3), v_new,
            'one pool: minutes from the voice-cloning bucket carried into the video bucket');

    update public.credit_balances
       set balance = 0, unlimited = false, updated_at = now()
     where user_id = v_src.user_id and modality = 'video_audio';
  end loop;
end $$;

-- -- 3. sl_grant_credits --------------------------------------------------------------------
-- The panel and the payment path both post minutes here. A grant aimed at the old cloning bucket
-- lands in the pool from now on, so an administrator can never put minutes where no call will look.
-- The ledger row is stamped with the bucket that received them, because its balance_after figure
-- belongs to that wallet and nothing else.
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
  v_pay       modality_flag := public.sl_pay_bucket(p_modality);
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
    and modality = v_pay
    and delta = round(p_minutes, 3)
    and coalesce(reason, '') = coalesce(p_reason, 'manual')
    and actor_id is not distinct from p_actor
    and created_at > now() - interval '15 seconds';
  if v_repeat > 0 then
    return jsonb_build_object('ok', false, 'deduped', true,
      'error', 'the same grant was recorded a few seconds ago - nothing was changed');
  end if;

  insert into public.credit_balances (user_id, modality, balance)
  values (p_user, v_pay, 0)
  on conflict (user_id, modality) do nothing;

  select balance, unlimited into v_balance, v_unlimited
  from public.credit_balances
  where user_id = p_user and modality = v_pay
  for update;

  v_switched := p_unlimited is not null and p_unlimited is distinct from v_unlimited;
  if p_unlimited is not null then
    v_unlimited := p_unlimited;
    update public.credit_balances set unlimited = v_unlimited
    where user_id = p_user and modality = v_pay;
  end if;

  v_after := round((v_balance + p_minutes)::numeric, 3);
  if v_after < 0 then v_after := 0; end if;   -- deductions clamp at zero

  update public.credit_balances
     set balance = v_after,
         total_credited = total_credited + greatest(p_minutes, 0),
         total_spent    = total_spent - least(p_minutes, 0),
         updated_at = now()
   where user_id = p_user and modality = v_pay;

  insert into public.credit_ledger
    (user_id, modality, kind, delta, balance_after, reason, request_id, actor_id)
  values
    (p_user, v_pay,
     case when p_minutes >= 0 then 'credit' else 'adjust' end,
     round(p_minutes, 3), v_after, coalesce(p_reason, 'manual'), p_request_id, p_actor);

  -- The unlimited switch changes what the account can spend without moving a
  -- single minute, so it needs its own ledger row or the audit trail has a hole.
  if v_switched then
    insert into public.credit_ledger
      (user_id, modality, kind, delta, balance_after, reason, request_id, actor_id)
    values
      (p_user, v_pay, 'adjust', 0, v_after,
       case when v_unlimited then 'access switched to unlimited' else 'access switched to metered' end,
       p_request_id, p_actor);
  end if;

  return jsonb_build_object('ok', true, 'balance', v_after, 'unlimited', v_unlimited);
end; $$;

-- -- 4. sl_take_back_minutes ----------------------------------------------------------------
-- A clawback has to reach the wallet the minutes actually went into, or a refused payment would
-- take nothing back and leave the account holding free airtime.
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
  v_pay  modality_flag := public.sl_pay_bucket(p_modality);
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
  where user_id = p_user and modality = v_pay
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
     where user_id = p_user and modality = v_pay;

    insert into public.credit_ledger (user_id, modality, kind, delta, balance_after, reason)
    values (p_user, v_pay, 'adjust', -v_take,
            (select balance from public.credit_balances
              where user_id = p_user and modality = v_pay),
            p_reason);
  end if;

  return jsonb_build_object('taken', v_take, 'shortfall', v_left);
end; $$;

-- -- 5. sl_settle_window --------------------------------------------------------------------
-- The rate stays the session's own (its modality is what was priced); only the wallet it pays from
-- and the ledger row it writes follow the map.
create or replace function public.sl_settle_window(p_session public.usage_sessions)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pay    modality_flag := public.sl_pay_bucket(p_session.modality);
  v_stop   timestamptz;
  v_base   timestamptz;
  v_real   numeric;
  v_charge numeric;
  v_refund numeric;
  v_mult   numeric;
begin
  insert into public.credit_balances (user_id, modality, balance)
  values (p_session.user_id, v_pay, 0)
  on conflict (user_id, modality) do nothing;

  v_mult := coalesce(p_session.multiplier, public.current_burn_rate(p_session.modality));
  v_stop := least(now(), coalesce(p_session.lease_expires_at, now()));
  v_base := coalesce(p_session.lease_started_at, p_session.started_at);

  if p_session.modality in ('video', 'video_audio') and p_session.media_started_at is null then
    v_real := 0;
  else
    if p_session.media_started_at is not null and p_session.media_started_at > v_base then
      v_base := p_session.media_started_at;
    end if;
    v_real := round(greatest(0, (extract(epoch from (v_stop - v_base)) / 60.0))::numeric, 3);
  end if;

  v_charge := round(least(p_session.pending_debit, v_real * v_mult)::numeric, 3);
  v_refund := round(greatest(0, p_session.pending_debit - v_charge)::numeric, 3);

  if v_refund > 0 and not (select unlimited from public.credit_balances
                           where user_id = p_session.user_id and modality = v_pay) then
    update public.credit_balances
       set balance = round((balance + v_refund)::numeric, 3),
           total_spent = greatest(0, total_spent - v_refund),
           updated_at = now()
     where user_id = p_session.user_id and modality = v_pay;

    insert into public.credit_ledger
      (user_id, modality, kind, delta, balance_after, reason, session_id)
    values
      (p_session.user_id, v_pay, 'release', v_refund,
       (select balance from public.credit_balances where user_id = p_session.user_id and modality = v_pay),
       'unused lease refunded', p_session.id);
  end if;

  if v_refund > 0 and p_session.engine = 'decart' and p_session.decart_key_id is not null then
    perform public.sl_release_decart_minutes(p_session.decart_key_id, v_refund);
  end if;

  if v_charge > 0 and p_session.fal_key_id is not null and coalesce(p_session.engine, 'fal') <> 'decart' then
    perform public.sl_book_key_minutes(p_session.fal_key_id, v_charge);
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

-- -- 6. sl_lease ----------------------------------------------------------------------------
-- Every wallet read and write follows the map; the no-picture bound, the pre-pay arithmetic and the
-- two figures the app counts its own deadline from are untouched, and 'modality' in the answer is
-- still the session's own so the app keeps pricing what it is watching.
create or replace function public.sl_lease(p_session_id uuid, p_action text)
 returns jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  s    public.usage_sessions;
  r    jsonb;
  v_pay modality_flag;
  v_cfg record;
  v_chunk numeric;
  v_balance numeric;
  v_unlimited boolean;
  v_min_start numeric;
  v_mult numeric;
  v_funded numeric;
begin
  if p_action not in ('renew', 'end', 'media') then
    return jsonb_build_object('ok', false, 'error', 'action must be renew, end or media');
  end if;

  select * into s from public.usage_sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'session not found');
  end if;
  v_pay := public.sl_pay_bucket(s.modality);
  if s.settled or s.ended_at is not null then
    return jsonb_build_object('ok', true, 'ended', true, 'settled', true,
                              'billed_minutes', s.billed_minutes, 'balance', null);
  end if;

  if p_action = 'media' then
    if s.media_started_at is null then
      update public.usage_sessions set media_started_at = now() where id = p_session_id;
    end if;
    return jsonb_build_object(
      'ok', true, 'ended', false,
      'media', true,
      'balance', (select balance from public.credit_balances
                  where user_id = s.user_id and modality = v_pay),
      'unlimited', (select unlimited from public.credit_balances
                    where user_id = s.user_id and modality = v_pay),
      'billed_minutes', s.billed_minutes,
      'lease_expires_at', s.lease_expires_at,
      'modality', s.modality::text);
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
                  where user_id = s.user_id and modality = v_pay),
      'modality', s.modality::text);
  end if;

  -- NO-PICTURE BOUND ---------------------------------------------------------
  -- Placed after the window above has been settled and refunded, so closing here owes
  -- nothing and gives back everything this lease had set aside.
  if s.modality in ('video', 'video_audio')
     and s.media_started_at is null
     and s.started_at < now() - interval '90 seconds' then
    update public.usage_sessions
       set ended_at = now(), settled = true, lease_expires_at = now(), pending_debit = 0
     where id = p_session_id;
    return r || jsonb_build_object(
      'ok', true, 'ended', true, 'reason', 'no_picture',
      'billed_minutes', (select billed_minutes from public.usage_sessions where id = p_session_id),
      'balance', (select balance from public.credit_balances
                  where user_id = s.user_id and modality = v_pay),
      'modality', s.modality::text);
  end if;

  -- renew: pre-debit the next window
  select * into v_cfg from public.app_config where id = 1;
  v_chunk := v_cfg.lease_chunk_minutes;

  select balance, unlimited into v_balance, v_unlimited
  from public.credit_balances
  where user_id = s.user_id and modality = v_pay
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
     where user_id = s.user_id and modality = v_pay;
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
    values (s.user_id, v_pay, 'debit', -v_chunk,
            (select balance from public.credit_balances where user_id = s.user_id and modality = v_pay),
            'lease renewed', p_session_id);
  end if;

  -- What the call has already cost, and what this window buys at the rate the session is
  -- metered at. The rate is read the way sl_settle_window reads it - the session's own figure
  -- first, the bucket's current rate only if the session never carried one - so the seconds
  -- named here and the minutes taken in the next window cannot disagree.
  --
  -- A video window is billed from the first frame, so until that stamp lands nothing is being
  -- consumed and no deadline is owed: null comes back, and the app keeps the countdown it
  -- already knows how to make. An unlimited bucket is never cut short, so it is null too.
  v_mult := coalesce(s.multiplier, public.current_burn_rate(s.modality));
  if v_unlimited or (s.modality in ('video', 'video_audio') and s.media_started_at is null) then
    v_funded := null;
  else
    -- Counted from the instant this window really starts, which is the earlier of now and the
    -- expiry the previous window wrote - the same bound sl_settle_window stops its billing at,
    -- read off the same record. A heartbeat that lands late has already flown part of the
    -- airtime it is being handed, and measuring from the moment of the ask would give that
    -- stretch back a second time.
    v_funded := round((extract(epoch from (least(now(), coalesce(s.lease_expires_at, now())) - now()))
                     + (v_chunk / nullif(v_mult, 0)) * 60.0)::numeric, 1);
  end if;

  return r || jsonb_build_object(
    'ok', true, 'ended', false,
    'balance', (select balance from public.credit_balances
                where user_id = s.user_id and modality = v_pay),
    'chunk_minutes', v_chunk,
    'lease_ttl_seconds', v_cfg.lease_ttl_seconds,
    'unlimited', v_unlimited,
    'billed_minutes', (select billed_minutes from public.usage_sessions where id = p_session_id),
    'funded_seconds', v_funded,
    'modality', s.modality::text);
end; $function$;

-- -- 7. sl_start_session --------------------------------------------------------------------
-- Changes here, and only here:
--   * the wallet reads, the pre-debit and the ledger row follow the map;
--   * a cloning call needs minutes the account PAID for, not the granted trial minute;
--   * the multiplier still comes from the asked modality, so the pool is priced per tab.
-- The ghost clear, the concurrency counts, the engine choice, the machine pacing and the no-picture
-- bound are the shipped text, unchanged.
create or replace function public.sl_start_session(p_user uuid, p_modality modality_flag, p_tab text, p_device text DEFAULT NULL::text)
 returns jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_sub       record;
  v_enabled   boolean;
  v_pay       modality_flag := public.sl_pay_bucket(p_modality);
  v_balance   numeric(10,3);
  v_unlimited boolean;
  v_cfg       record;
  v_open      integer;
  v_video_open integer;
  v_trial_open integer;
  v_user_trial integer;
  v_ready     integer;
  v_engine    text;
  v_chunk     numeric(10,3);
  v_min_start numeric(10,3);
  v_session   uuid;
  v_mult      numeric(6,3);
  v_stale     integer := 0;
  v_old       record;
  v_asked_ago numeric;
  v_dead      integer;
  v_hold      integer;
  v_wait      integer;
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

  -- CLONING IS NOT ON THE TRIAL ----------------------------------------------
  -- The rule below, and the reason it is not simply the rate: a call that is anything but plain
  -- video is forced onto the paid video engine a little further down, and a cloning call also opens
  -- the voice service. So a granted trial minute would buy two paid services off the workspace keys
  -- and charge one free minute for them. The trial was sold as a look at the video, and it stays
  -- exactly that. Said with its own reason, because the account genuinely does hold minutes -
  -- "you are out of minutes" would be a lie the customer can disprove on his own screen.
  if p_modality = 'video_audio' and not coalesce(public.sl_account_is_paid(p_user), false) then
    return jsonb_build_object('allowed', false, 'reason', 'clone_needs_paid_minutes');
  end if;

  select * into v_cfg from public.app_config where id = 1;
  if coalesce(v_cfg.maintenance, false) then
    return jsonb_build_object('allowed', false, 'reason', 'maintenance',
                              'message', coalesce(v_cfg.maintenance_message, 'gateway under maintenance'));
  end if;

  v_chunk := v_cfg.lease_chunk_minutes;
  v_mult := public.current_burn_rate(p_modality);

  insert into public.credit_balances (user_id, modality, balance)
  values (p_user, v_pay, 0)
  on conflict (user_id, modality) do nothing;

  select balance, unlimited into v_balance, v_unlimited
  from public.credit_balances
  where user_id = p_user and modality = v_pay
  for update;

  -- GHOST CLEAR ---------------------------------------------------------------
  -- This sits above the account-wide ceiling deliberately: that count includes the
  -- unfinished lease, so on a one-line account the ghost would be refused there first
  -- and the machine would still be locked out.
  --
  -- Scoped to this machine and this bucket, so an account that is allowed two lines
  -- keeps the arrangement it was sold - a laptop running video and audio on one
  -- machine is still one call per machine per bucket, and a phone on the same account
  -- is untouched because its device id differs.
  if p_device is not null then
    for v_old in
      select id from public.usage_sessions
      where user_id = p_user
        and modality = p_modality
        and device_id = p_device
        and ended_at is null
        and lease_expires_at > now()
      for update
    loop
      perform public.sl_lease(v_old.id, 'end');
      v_stale := v_stale + 1;
    end loop;
    if v_stale > 0 then
      raise notice 'sl_start_session closed % unfinished lease(s) user=% modality=% device=%',
        v_stale, p_user, p_modality, p_device;
    end if;
  end if;

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

    -- One trial line per account, whatever that account's own ceiling says, and quite separate
    -- from the count above: that one is every trial on the service, this one is this customer's.
    -- A granted minute is one seat, not two - two trials running at once take double the pool
    -- and bill nothing, and the free minute was never sold as a pair. Five strangers signing up
    -- in the same minute are untouched by each other because this reads p_user, and a paid
    -- account never lands here at all: paid video runs on the other engine, so the two lines it
    -- was sold are kept.
    --
    -- A restart on the SAME machine still passes, deliberately: the unfinished lease from that
    -- machine was closed a little way above, before this count, so an app that lost its Stop is
    -- not punished twice for it.
    select count(*) into v_user_trial
    from public.usage_sessions
    where user_id = p_user
      and ended_at is null
      and lease_expires_at > now()
      and engine = 'decart';
    if v_user_trial >= 1 then
      return jsonb_build_object('allowed', false, 'reason', 'concurrent_limit',
                                'open_sessions', v_user_trial,
                                'trial_lines_per_account', 1,
                                'engine', 'decart');
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

  -- MACHINE PACING -------------------------------------------------------------
  -- Only a paid video line is paced, and the clock is that machine's previous video
  -- attempt - whichever account was signed in on it. The read is scoped by device id
  -- alone and not by user, because the answer comes back per machine.
  --
  -- Anchoring on the attempt rather than on the call end is deliberate: a Stop that
  -- never reached the server is stamped just now by the ghost clear above, so if this
  -- clock read that stamp, an ordinary lost Stop would lock the machine out for the
  -- whole hold, which is exactly the incident the previous migration closed.
  --
  -- The refusal reuses the busy-line reason the installed app already knows how to say,
  -- and adds the seconds it should wait. Nothing is opened and nothing is debited here;
  -- the money gates have already had their say above, so a machine held at this gate is
  -- not being held out of its balance.
  if v_engine = 'fal' and p_modality in ('video', 'video_audio') and p_device is not null then
    select extract(epoch from (now() - max(started_at)))
      into v_asked_ago
      from public.usage_sessions
     where device_id = p_device
       and engine = 'fal'
       and modality in ('video', 'video_audio');

    if v_asked_ago is not null then
      -- How many of this machine's last three video passes never produced a picture.
      select count(*) into v_dead
        from (
          select media_started_at
            from public.usage_sessions
           where device_id = p_device
             and engine = 'fal'
             and modality in ('video', 'video_audio')
           order by started_at desc
           limit 3
        ) v_last
       where v_last.media_started_at is null;

      v_hold := case when v_dead >= 3 then 240 else 120 end;
      v_wait := v_hold - floor(v_asked_ago)::int;

      if v_wait > 0 then
        -- Written to the refused-call log the seller already reads. A paced machine never
        -- opens a session, so without this the fix would look like a drop in refusals
        -- rather than what it is, and there would be no way to see how often a machine is
        -- being held or for how long. Best effort on purpose: a log that is missing (or a
        -- table that was never created) must never be the reason a Start fails.
        begin
          insert into public.call_failures (user_id, session_id, stage, detail)
          values (p_user, null, 'paced',
                  'held ' || greatest(v_wait, 5) || 's of a ' || v_hold || 's window'
                  || ' on machine ' || left(p_device, 12)
                  || ', ' || v_dead || ' of its last 3 passes showed no picture');
        exception when undefined_table then
          null;
        end;

        return jsonb_build_object('allowed', false,
                                  'reason', 'lines_busy',
                                  'engine', 'fal',
                                  'retry_after_seconds', greatest(v_wait, 5),
                                  'detail', 'this machine asked again too soon');
      end if;
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
     where user_id = p_user and modality = v_pay;

    insert into public.credit_ledger
      (user_id, modality, kind, delta, balance_after, reason, session_id)
    values
      (p_user, v_pay, 'debit', -v_chunk,
       (select balance from public.credit_balances where user_id = p_user and modality = v_pay),
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
    'stale_closed', v_stale,
    'balance', (select balance from public.credit_balances where user_id = p_user and modality = v_pay)
  );
end; $function$;

-- -- 8. The snapshot the app and the panel both read -----------------------------------------
-- Two figures are added and nothing that was there is moved: the cloning door as the account sees
-- it (so the app can grey the tab out instead of letting a customer sit at a button that will be
-- refused), and the live rate for every modality (so a bucket that has never been touched can be
-- priced correctly rather than read back as 1).
create or replace function public.sl_account_snapshot(p_user uuid default auth.uid())
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  -- No session, or a caller asking for someone else's account without being an
  -- admin, gets the same short answer. There is no anonymous view of a wallet.
  if p_user is null or auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'not signed in');
  end if;
  if auth.uid() <> p_user and not public.is_admin(auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select jsonb_build_object(
    'ok', true,
    'user_id', p_user,
    'paid', coalesce(public.sl_account_is_paid(p_user), false),
    'status', coalesce((select s.status::text from public.subscriptions s where s.user_id = p_user), 'none'),
    'plan_id', (select s.plan_id from public.subscriptions s where s.user_id = p_user),
    'modalities', jsonb_build_object(
      'video',       coalesce((select s.video_enabled       from public.subscriptions s where s.user_id = p_user), false),
      'audio',       coalesce((select s.audio_enabled       from public.subscriptions s where s.user_id = p_user), false),
      'video_audio', coalesce((select s.video_audio_enabled from public.subscriptions s where s.user_id = p_user), false)),
    'max_concurrent_sessions', coalesce((select s.max_concurrent_sessions from public.subscriptions s where s.user_id = p_user), 1),
    'burn_rates', coalesce((
      select jsonb_object_agg(r.modality::text, r.multiplier)
      from public.burn_rates r where r.retired_at is null), '{}'::jsonb),
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
                                      'maintenance_message', c.maintenance_message,
                                      'contact', jsonb_build_object(
                                        'message',  c.contact_message,
                                        'whatsapp', c.contact_whatsapp,
                                        'telegram', c.contact_telegram),
                                      'pay', jsonb_build_object(
                                        'momo', c.pay_momo,
                                        'btc',  c.pay_btc))
            from public.app_config c where c.id = 1)
  ) into v;
  return v;
end; $$;

revoke execute on function public.sl_account_snapshot(uuid) from anon;
grant execute on function public.sl_account_snapshot(uuid) to authenticated;
