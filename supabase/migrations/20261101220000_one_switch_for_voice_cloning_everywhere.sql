-- -- One global switch for voice cloning -------------------------------------------------
-- app_config.cloning_enabled closes the Video + Audio tab for EVERY account at once, while the
-- per-account tick keeps working underneath it. Two things had to change together, because they
-- answer two different questions:
--   1. sl_start_session refuses a cloning dial. This is the authority: it runs before any minute
--      is debited and before any video key or voice key is minted, so a closed switch costs the
--      workspace nothing. An edited app cannot walk around it, because the dial itself is the
--      only way in.
--   2. sl_account_snapshot folds the switch into modalities.video_audio, which is the single
--      figure the app already reads to grey the tab out. So the door closes on screen for the
--      builds your customers already have installed: no new app is needed for the switch to be
--      seen, and a customer cannot sit at a Start button that is only going to refuse them.
-- Default is true: installing this changes nothing on anybody until you turn it off.

alter table public.app_config
  add column if not exists cloning_enabled boolean not null default true;

comment on column public.app_config.cloning_enabled is
  'Global voice-cloning switch. False closes the Video + Audio tab for every account, beside the
   per-account tick. True is the behaviour you have today.';

-- The bodies below are the ones in 20261101120000, carried across with only the two changes
-- described above. Nothing else in either function moved.

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

  -- ONE SWITCH, EVERY ACCOUNT ----------------------------------------------
  -- The per-account tick says whether cloning is open on this customer. This says whether the
  -- feature is open at all: the administrator can close voice-cloning across the whole software
  -- without touching anybody's account, and every account that has not paid for it is refused at
  -- the door. Default true, so nothing moves until he deliberately switches it off.
  if p_modality = 'video_audio' and not coalesce(v_cfg.cloning_enabled, true) then
    return jsonb_build_object('allowed', false, 'reason', 'clone_closed');
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
      'video_audio', coalesce((select s.video_audio_enabled from public.subscriptions s where s.user_id = p_user), false)
        and coalesce((select c.cloning_enabled from public.app_config c where c.id = 1), true)),
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

