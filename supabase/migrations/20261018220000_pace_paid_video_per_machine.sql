-- The complaint: a customer presses Start, gets a picture, stops, presses Start again a
-- few seconds later, and the app says the call could not be started. The refused-call
-- log blames a concurrent session limit. It is not one. Nothing on the account is open
-- at that minute - the record is closed, the machine is idle, the screen is blank. The
-- pass is issued anyway and the video service drops it about six seconds later without
-- ever sending a picture.
--
-- Measured on the live records, last thirty days of paid video calls:
--
--   * The outcome follows the MACHINE, not the account and not the key. Five machines
--     produced 4/65, 5/16, 1/4, 3/3 and 1/1. On one day one machine went 0/3 while two
--     others, on different accounts, were 3/3 and 1/1.
--   * Spacing is the strongest lever. A pass asked for less than a minute after that
--     same machine's previous pass reached a picture 4 times in 55 (7%). Asked a minute
--     or more later: 9 in 33 (27%). Inside the busiest machine alone, 2 in 48 against
--     2 in 15.
--   * The failures are fast: 68 of 75 died within eight seconds, so they never even
--     reached the app's own thirty-second deadline. A pass with no picture by then is
--     not going to produce one.
--   * Two provider accounts, opened apart and keyed apart, refuse alike - so this is
--     not one account short of capacity.
--
-- The provider's own description of the paid path explains why the machine is what
-- counts: their service only introduces the two ends, and the picture then flows
-- directly between that customer's browser and the model. The identity the far side sees
-- is the machine, and a machine that presents itself again seconds after its last
-- introduction is doing it while the previous one is still being cleared away.
--
-- So: stop handing out a pass that can already be predicted to die, and say so honestly
-- instead. A machine that asked for a paid video line less than a minute ago is told,
-- before anything is opened or debited, that the line it just used is still being
-- released, and roughly how long to wait. A machine whose last three asks never produced
-- a picture gets three minutes. This is deliberately NOT the account ceiling lowered to
-- one: two customers on two machines keep their two lines and never see this message,
-- and nobody is asked to sit behind another person's call.

-- -- Start, with the machine paced -------------------------------------------
-- Body is the current sl_start_session from 20261015110000_close_stale_lease_on_start
-- with one block added immediately before the session is opened. Every other gate is in
-- the same order and does the same thing. A create-or-replace keeps the EXECUTE rights
-- earlier migrations gave.
--
-- The new gate runs after the ghost lease has been closed and settled on purpose: the
-- record is made true first, so the next Start from that machine is never refused for a
-- bookkeeping reason, and nothing is debited by an attempt this gate turns away.
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
  -- clock read that stamp, an ordinary lost Stop would lock the machine out for a
  -- minute, which is exactly the incident the previous migration closed.
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

      v_hold := case when v_dead >= 3 then 180 else 60 end;
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
    'stale_closed', v_stale,
    'balance', (select balance from public.credit_balances where user_id = p_user and modality = p_modality)
  );
end; $$;
