-- A renewed lease has to say what it took, or the app stops counting ------------------------------
--
-- The heartbeat renews a call every 45 seconds. On a renewal the gate settles the window that
-- elapsed, hands back whatever went unused, and pre-pays the next one - and then answered with
-- "renewed" and the new balance, but never with the minutes it had just charged. The app reads
-- that figure on every other path, so on this one it kept the number it already had, which for a
-- call that started with nothing left in the wallet meant zero. Its countdown refilled at every
-- heartbeat, its own stop timer re-armed a minute further each time, and the call stayed on air
-- long after the money for it was spent. The charge is capped at the pre-paid chunk, so the extra
-- airtime left the video pool and never appeared anywhere as money.
--
-- Measured, not argued: one trial call ran 92 seconds of picture on a 60-second grant and was
-- charged 1.000. The gate funded it until 21:24:18; the next heartbeat arrived at 21:24:49, was
-- refused, and the call died at 21:24:50. Across the book since 10-14 this has given away 2.422
-- trial minutes on 18 closed calls. The paid line shows 0.000 unbilled across 19 closed calls,
-- because a paid renewal needs a whole minute on hand to go on at all - the gate, not the app,
-- is what stops it there.
--
-- Two numbers are added to the renewal answer and nothing else in this function moves: the minutes
-- charged so far, which the installed app already knows how to read, so builds out there right now
-- start cutting on time without a download; and the seconds that pre-paid chunk buys at this
-- session's own rate, which only a new build reads, so a deadline can be obeyed instead of
-- estimated. An app that has not been updated ignores a field it has never seen.
--
-- The second change is in the start gate, and it is a rule the panel cannot express: a free trial
-- line is one per account. The trial ceiling the panel offers counts every trial on the service, so
-- setting it to one would leave the fifth new customer of the morning unable to try the product at
-- all. The count added here is scoped to the account pressing Start, and paid accounts keep the two
-- lines they were sold.
--
-- Both definitions below are the live text, copied out of the database before this file was written,
-- with only the insertions above applied to them. That is deliberate: a rewritten-from-memory version
-- of a money function is how a clause gets lost.
-- -- 1. sl_lease ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sl_lease(p_session_id uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  s    public.usage_sessions;
  r    jsonb;
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
                  where user_id = s.user_id and modality = s.modality),
      'unlimited', (select unlimited from public.credit_balances
                    where user_id = s.user_id and modality = s.modality),
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
                  where user_id = s.user_id and modality = s.modality),
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
                where user_id = s.user_id and modality = s.modality),
    'chunk_minutes', v_chunk,
    'lease_ttl_seconds', v_cfg.lease_ttl_seconds,
    'unlimited', v_unlimited,
    'billed_minutes', (select billed_minutes from public.usage_sessions where id = p_session_id),
    'funded_seconds', v_funded,
    'modality', s.modality::text);
end; $function$;

comment on function public.sl_lease(uuid, text) is
  'Renew, end, or stamp the first frame of an open lease. A video lease that has never sent '
  'the frame stamp is closed instead of renewed once it is older than 90 seconds - still '
  'charged nothing, with every window refunded. A renewal answers with the minutes charged so '
  'far and the seconds the new window buys, because the app ends the call off those numbers.';

-- -- 2. sl_start_session -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sl_start_session(p_user uuid, p_modality modality_flag, p_tab text, p_device text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_sub       record;
  v_enabled   boolean;
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
end; $function$;
