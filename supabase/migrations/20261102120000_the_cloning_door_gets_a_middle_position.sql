-- The cloning door gets a middle position, and voice-only pays from the one pool -----------
--
-- What this file does, in six parts:
--
-- 1. THE POOL TAKES THE AUDIO LINE TOO. `sl_pay_bucket` already folded the Video + Audio call
--    into the video wallet; the voice-only call is folded with it. Nothing else about the money
--    moves: the rate is still read from the call's OWN modality, so a voice-only call is metered
--    at the audio rate on the Burn rates tab and a Video + Audio call at its own. No rate is
--    invented here and none is raised - the audio figure this file falls back to is the one that
--    has been in the table since it was seeded.
--
-- 2. ANY AUDIO WALLET IS CARRIED INTO THE POOL. The same rule the Video + Audio bucket got: what
--    it held travels to that account's video bucket, the move is written to the ledger with its
--    own reason, and the source row is zeroed rather than deleted so the history still names its
--    modality. A customer cannot lose a minute he was granted.
--
-- 3. ONE DOOR, THREE POSITIONS. `cloning_mode` is 'off', 'voice_only' or 'voice_video', on
--    app_config for the whole software and on subscriptions for one account. The account's own
--    line can only ever narrow the global one, never open what the global line has closed. The
--    two boolean columns the software already reads - app_config.cloning_enabled and
--    subscriptions.video_audio_enabled / audio_enabled - are kept in step by a trigger, so an
--    installed app or an older copy of the panel still sees a consistent pair of figures and
--    nobody has to ship a new app for the door to work.
--
-- 4. VOICE-ONLY IS A PAID CALL, LIKE THE CLONING TAB. A granted trial minute is refused at the
--    gate for both, with the same reason, because neither has a free path: the voice service is
--    billed to the workspace keys the moment it answers.
--
-- 5. ONE CLONING CALL PER MACHINE. A machine may hold a voice-only call or a Video + Audio call,
--    never both, because two voices on one cable is the confusion this feature would otherwise
--    create. The call already on air is CLOSED when the other is asked for, not the new one
--    refused: a lost Stop must never lock a customer out of the call he is now asking for. Two
--    machines on one account are untouched by each other, because the read is scoped by device id.
--
-- 6. THE PACKAGE SIDE. A package priced with an Audio line would now grant into the same wallet
--    as its Video line, and two grants with the same account, wallet, figure and reason inside one
--    second are read by the duplicate guard as an accidental repeat: the settlement would roll
--    back whole, Paystack would have the money and the buyer would have no minutes. Exactly the
--    hole 20261101210000 closed for the Video + Audio line, so the audio leg is folded the same
--    way - one ask per wallet. Not one stored package figure moves: every line this touches is 0
--    today, and the fold only acts on a statement that is itself re-pricing that line.
--
-- What this file does NOT do: it does not touch the burn rates, the packages, the prices, the
-- payment gateway, the licence generation or the money maths. A window is still charged from its
-- first frame, still capped at the pre-paid chunk, and still gives back what it did not use. The
-- 40-second no-picture bound from 20261101230000 is untouched, and it never applies to a
-- voice-only call, which has no picture to wait for.
--
-- The function bodies below are the live text copied out of the newest migration that defines each
-- one, with only the changes named above applied. Nothing else was rewritten.
--   sl_start_session / sl_account_snapshot  <- 20261101220000_one_switch_for_voice_cloning_everywhere.sql
--   sl_payment_deliver / sl_plans_one_pool  <- 20261101210000_the_package_side_of_the_one_pool.sql
-- sl_grant_credits, sl_take_back_minutes, sl_settle_window and sl_lease are NOT restated here:
-- every one of them already asks sl_pay_bucket which wallet to use, so the fold reaches them on
-- its own and re-typing a money function to change nothing is how a clause gets lost.

-- -- 1. Which wallet a modality spends from ----------------------------------------
create or replace function public.sl_pay_bucket(p_modality modality_flag)
returns modality_flag
language sql
immutable
as $$
  select case when p_modality in ('video_audio', 'audio') then 'video'::modality_flag else p_modality end;
$$;

comment on function public.sl_pay_bucket(modality_flag) is
  'The bucket a call actually spends minutes from. A Video + Audio call and a voice-only cloning '
  'call both pay from the one pool; each keeps its own modality, which still decides the rate. '
  'Nothing else maps modalities to wallets.';

revoke execute on function public.sl_pay_bucket(modality_flag) from anon;
grant execute on function public.sl_pay_bucket(modality_flag) to authenticated, service_role;

-- -- 2. Fold what an audio wallet held into the pool ---------------------------------
do $$
declare
  v_src record;
  v_new numeric(10,3);
begin
  for v_src in
    select * from public.credit_balances
     where modality = 'audio'
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
            'one pool: minutes from the voice-only bucket carried into the video bucket');

    update public.credit_balances
       set balance = 0, unlimited = false, updated_at = now()
     where user_id = v_src.user_id and modality = 'audio';
  end loop;
end $$;

-- -- 3. One door, three positions ----------------------------------------------------
-- 'off' shuts the whole of the cloning side. 'voice_only' lets a voice-only call run and keeps
-- the Video + Audio tab dead. 'voice_video' is what the software does today. The names are the
-- three lines the administrator sees on the panel, in the same order.
alter table public.app_config
  add column if not exists cloning_mode text not null default 'voice_video'
    check (cloning_mode in ('off', 'voice_only', 'voice_video'));

alter table public.subscriptions
  add column if not exists cloning_mode text
    check (cloning_mode in ('off', 'voice_only', 'voice_video'));

comment on column public.app_config.cloning_mode is
  'The whole-software cloning line: off / voice only / voice + video. It can only narrow what '
  'every account is allowed; an account line can never open what this one has closed. '
  'app_config.cloning_enabled is kept in step with it by sl_cloning_door_mirror.';

comment on column public.subscriptions.cloning_mode is
  'This account''s cloning line: off / voice only / voice + video. Null until a row has been '
  'stamped, which reads as whatever its own booleans say. '
  'subscriptions.video_audio_enabled and audio_enabled are kept in step with it.';

-- Backfill from the figures the software already holds, so installing this changes nothing on
-- anybody's account. An account whose Video + Audio tick is on becomes 'voice_video'; one whose
-- tick is off becomes 'off'. The middle position is never backfilled, because nothing in the
-- software has ever been able to ask for it - he sets it by name from the panel.
update public.app_config
   set cloning_mode = case when coalesce(cloning_enabled, true) then 'voice_video' else 'off' end
 where id = 1;

update public.subscriptions
   set cloning_mode = case when coalesce(video_audio_enabled, true) then 'voice_video' else 'off' end
 where cloning_mode is null;

-- The mirror: one place that keeps the new line and the old booleans telling the same story,
-- whichever of them a write touches. Installed apps read the booleans through
-- sl_account_snapshot and an older copy of the panel writes them, so neither is allowed to end up
-- disagreeing with the line that actually decides a call.
--
-- The rule runs one way at a time, in this order: a write that moves the LINE stamps the booleans;
-- a write that moves only a BOOLEAN moves the line, and the two-value boolean can only ever mean
-- off or voice + video, because the middle position is new and is set by name. A write that touches
-- neither (a status change, a device count) leaves the line where it is and re-stamps the pair,
-- which changes nothing while they agree and repairs them if something has written around this
-- trigger.
create or replace function public.sl_cloning_door_mirror()
returns trigger
language plpgsql
as $$
declare
  v_mode text;
  v_bool boolean;
  v_old  boolean;
begin
  if tg_table_name = 'app_config' then
    v_bool := coalesce(NEW.cloning_enabled, true);
    v_old  := coalesce(OLD.cloning_enabled, true);
  else
    v_bool := coalesce(NEW.video_audio_enabled, true);
    v_old  := coalesce(OLD.video_audio_enabled, true);
  end if;

  if tg_op = 'INSERT' then
    v_mode := coalesce(NEW.cloning_mode, case when v_bool then 'voice_video' else 'off' end);
  elsif NEW.cloning_mode is distinct from OLD.cloning_mode then
    -- A write that sets the line back to null is a write that closed cloning, not one that asked
    -- the trigger to guess.
    v_mode := coalesce(NEW.cloning_mode, 'off');
  elsif v_bool is distinct from v_old then
    -- Something that only knows the two positions moved the tick, so it gets the two answers it
    -- has always given. An account tick switched off closes the voice-only call with it: the old
    -- panel had no way to say 'voice only', and an administrator who has just closed cloning on
    -- this account must not be answered with a call that still clones.
    v_mode := case when v_bool then 'voice_video' else 'off' end;
  else
    v_mode := coalesce(NEW.cloning_mode,
                       case when v_bool then 'voice_video' else 'off' end);
  end if;

  if tg_table_name = 'app_config' then
    NEW.cloning_mode    := v_mode;
    NEW.cloning_enabled := (v_mode <> 'off');
  else
    NEW.cloning_mode        := v_mode;
    NEW.video_audio_enabled := (v_mode =  'voice_video');
    -- audio_enabled has stopped being a door of its own: the app no longer has an Audio Call tab,
    -- and from here the figure means "this account may clone by voice at all". Keeping it stamped
    -- from the line is what makes an older screen that still reads it tell the truth.
    NEW.audio_enabled       := (v_mode <> 'off');
  end if;
  return NEW;
end; $$;

comment on function public.sl_cloning_door_mirror() is
  'BEFORE row trigger on app_config and subscriptions: keeps cloning_mode and the older boolean '
  'switches in step. A write that moves the new line stamps the booleans; a write from something '
  'that only knows the booleans moves the line.';

drop trigger if exists sl_cloning_door_mirror on public.app_config;
create trigger sl_cloning_door_mirror
  before insert or update on public.app_config
  for each row execute function public.sl_cloning_door_mirror();

drop trigger if exists sl_cloning_door_mirror on public.subscriptions;
create trigger sl_cloning_door_mirror
  before insert or update on public.subscriptions
  for each row execute function public.sl_cloning_door_mirror();

-- The one answer every door in this file asks for: how far THIS account may clone, once the
-- whole-software line has had its say. Highest common position, because the global line can only
-- narrow an account and an account can only narrow the software.
create or replace function public.sl_cloning_mode(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when d.g = 'off' or d.a = 'off' then 'off'
    when d.g = 'voice_only' or d.a = 'voice_only' then 'voice_only'
    else 'voice_video'
  end
  from (
    select coalesce((select c.cloning_mode from public.app_config c where c.id = 1),
                    case when coalesce((select c.cloning_enabled from public.app_config c where c.id = 1), true)
                         then 'voice_video' else 'off' end) as g,
           -- An account with no subscription row has been promised nothing, so it holds no cloning
           -- line. Reading it as 'voice_video' would grey the tab open on a snapshot taken before
           -- the row lands, which is exactly what the figure was there to prevent.
           coalesce(
             (select s.cloning_mode from public.subscriptions s where s.user_id = p_user),
             case when not exists (select 1 from public.subscriptions x where x.user_id = p_user) then 'off'
                  when coalesce((select s.video_audio_enabled from public.subscriptions s where s.user_id = p_user), true)
                       then 'voice_video' else 'off' end) as a
  ) d;
$$;

comment on function public.sl_cloning_mode(uuid) is
  'How far this account may clone: off, voice_only or voice_video. The whole-software line and '
  'the account line at their lowest common position - neither can open what the other has closed.';

revoke execute on function public.sl_cloning_mode(uuid) from anon;
grant execute on function public.sl_cloning_mode(uuid) to authenticated, service_role;

-- -- 4. sl_start_session -------------------------------------------------------------
-- Carried across from 20261101220000 with three changes and nothing else:
--   * the cloning door is the three-position line, and it now answers for a voice-only call too;
--   * the paid-account rule covers both cloning modalities instead of only the Video + Audio one;
--   * the unfinished-lease clear on a machine reaches across the two cloning calls, so one machine
--     holds one cloning call and switching between them is a close-and-open, never a refusal.
-- The engine choice, the wallet gate, the concurrency counts, the trial parity, the workspace
-- ceiling and the machine pacing are the shipped text, unedited.

create or replace function public.sl_start_session(p_user uuid, p_modality modality_flag, p_tab text, p_device text DEFAULT NULL::text)
 returns jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_sub       record;
  v_mode      text;
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

  -- THE ACCOUNT'S OWN TICK ----------------------------------------------------
  -- The plain Video Call tab keeps its own switch, exactly as before. The two cloning calls are
  -- asked of the three-position line instead, a little further down - below maintenance, so a
  -- closed feature and a closed account both answer with the reason the customer can act on
  -- rather than with "this call type is off".
  if p_modality = 'video' then
    if v_sub.video_enabled is not true then
      return jsonb_build_object('allowed', false, 'reason', 'modality_disabled');
    end if;
  end if;

  -- CLONING IS NOT ON THE TRIAL ----------------------------------------------
  -- The rule below, and the reason it is not simply the rate: a call that is anything but plain
  -- video is forced onto the paid video engine a little further down, and either cloning call also
  -- opens the voice service. So a granted trial minute would buy two paid services off the
  -- workspace keys and charge one free minute for them. The trial was sold as a look at the video,
  -- and it stays exactly that. Said with its own reason, because the account genuinely does hold
  -- minutes - "you are out of minutes" would be a lie the customer can disprove on his own screen.
  if p_modality in ('video_audio', 'audio')
     and not coalesce(public.sl_account_is_paid(p_user), false) then
    return jsonb_build_object('allowed', false, 'reason', 'clone_needs_paid_minutes');
  end if;

  select * into v_cfg from public.app_config where id = 1;
  if coalesce(v_cfg.maintenance, false) then
    return jsonb_build_object('allowed', false, 'reason', 'maintenance',
                              'message', coalesce(v_cfg.maintenance_message, 'gateway under maintenance'));
  end if;

  -- ONE DOOR, THREE POSITIONS, FOR BOTH CLONING CALLS -------------------------
  -- The account's own line says how far this customer may clone; the whole-software line says how
  -- far the feature is open at all, and it can only ever narrow the account, never widen it. The
  -- answer is folded into one figure by sl_cloning_mode, so an administrator closing the tab for
  -- everybody and closing it for one customer are the same clause with the same reason.
  --
  -- 'voice_only' is the middle position he asked for: a voice-only call is allowed and the Video +
  -- Audio tab stays dead. A voice-only dial refused under 'off' says clone_closed rather than
  -- "this call type is off", because the sentence the customer needs is the one about cloning.
  v_mode := public.sl_cloning_mode(p_user);
  if p_modality = 'video_audio' and v_mode <> 'voice_video' then
    return jsonb_build_object('allowed', false, 'reason', 'clone_closed');
  end if;
  if p_modality = 'audio' and v_mode = 'off' then
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
  --
  -- The ONE CLONING CALL WIDENING is the only change to this loop, and it is what makes the two
  -- Start buttons on the cloning side safe to press in any order. A machine may hold a voice-only
  -- call or a Video + Audio call, never both, because two voices on one cable is the confusion this
  -- feature would otherwise create. The other call is CLOSED here rather than the new one refused:
  -- a lost Stop must never lock a machine out of the call its customer is now asking for, which is
  -- the incident 20261015110000 exists to prevent. Closing it settles the window it ran and gives
  -- back what it did not use, so nothing is charged for a call that was cut short - and the switch
  -- over costs the account the same as pressing Stop and then Start.
  if p_device is not null then
    for v_old in
      select id from public.usage_sessions
      where user_id = p_user
        and device_id = p_device
        and (
          modality = p_modality
          or (p_modality in ('audio', 'video_audio') and modality in ('audio', 'video_audio'))
        )
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

-- -- 5. sl_account_snapshot ----------------------------------------------------------
-- The two figures an installed app already reads stay the two figures it reads, and they now carry
-- the middle position:
--   modalities.video_audio - the Video + Audio tab: only while BOTH lines say voice + video.
--   modalities.audio       - the voice-only side: only while BOTH lines allow at least voice only.
-- A third key is deliberately not invented: an app that has not been rebuilt still greys the tab
-- out correctly off video_audio, and a rebuilt app greys the voice-only button off audio.

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
      -- Both cloning figures come off ONE read of the door, so the tab and the voice-only button
      -- can never be told different stories by an account row and a config row that disagree.
      -- 'audio' is the voice-only side and 'video_audio' is the tab that also moves a picture; the
      -- whole-software line is already folded into both by sl_cloning_mode.
      'audio',       public.sl_cloning_mode(p_user) <> 'off',
      'video_audio', public.sl_cloning_mode(p_user) =  'voice_video'),
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

comment on function public.sl_account_snapshot(uuid) is
  'One read of an account: the pool it holds, what each kind of call is metered at, and how far '
  'it may clone. audio is the voice-only door, video_audio is the Video + Audio tab, each one '
  'already folded with the whole-software line.';

-- -- 6. The package side: one ask per wallet ------------------------------------------
-- Carried across from 20261101210000 with the audio leg folded into the pool ask, for the reason
-- in the header: a package priced on both lines would otherwise hand the duplicate guard two
-- identical grants and roll a paid settlement back whole. No stored package figure moves here -
-- every audio line on the shelf is 0 today, which is what the audit in that file recorded.

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
      -- One ask per wallet, on purpose. The Video + Audio tab and the voice-only call both spend
      -- this same pool figure at their own burn rates, so both retired columns are added into it
      -- instead of being granted beside it. The audio line joins the fold because sl_pay_bucket
      -- now answers 'video' for it too: kept as a second leg it would hand the duplicate guard two
      -- grants with the same account, wallet, figure and reason inside one second, and a refused
      -- grant rolls a PAID settlement back whole.
      ('video'::modality_flag, coalesce(v_plan.video_minutes, 0)
                               + coalesce(v_plan.video_audio_minutes, 0)
                               + coalesce(v_plan.audio_minutes, 0))
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
  ' payment settlement functions, as the service role. One grant per wallet: the one pool funds'
  ' every call tab, so the retired Video + Audio and Audio columns fold into that single ask.';

create or replace function public.sl_plans_one_pool()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Nested on purpose: a boolean AND in SQL is not promised to skip its right side, and asking
  -- for the old row during an INSERT is an error. The figure is only looked at when this
  -- statement is the one moving it.
  if TG_OP = 'INSERT' or NEW.video_audio_minutes is distinct from OLD.video_audio_minutes then
    if coalesce(NEW.video_audio_minutes, 0) <> 0 then
      NEW.video_minutes       := coalesce(NEW.video_minutes, 0) + NEW.video_audio_minutes;
      NEW.video_audio_minutes := 0;
    end if;
  end if;

  -- The voice-only line is folded by the same rule for the same reason: a voice-only call spends
  -- video_minutes at the audio burn rate, so a figure typed into this column would be minutes
  -- granted into a wallet no call draws from.
  if TG_OP = 'INSERT' or NEW.audio_minutes is distinct from OLD.audio_minutes then
    if coalesce(NEW.audio_minutes, 0) <> 0 then
      NEW.video_minutes := coalesce(NEW.video_minutes, 0) + NEW.audio_minutes;
      NEW.audio_minutes := 0;
    end if;
  end if;

  return NEW;
end; $$;

comment on function public.sl_plans_one_pool() is
  'BEFORE insert/update row trigger on public.plans: a write that puts a figure on a retired'
  ' per-tab column (Video + Audio, Audio) folds it into the single pool column and leaves that'
  ' line at 0. Does nothing to a row this statement is not re-pricing.';

comment on column public.plans.video_audio_minutes is
  'Retired by the one pool (20261101120000): the Video + Audio tab spends video_minutes at its'
  ' own burn rate, so this line sells nothing separate. Kept so older packages stay readable;'
  ' sl_plans_one_pool folds any figure written to it into video_minutes, and'
  ' sl_payment_deliver adds it into the single pool grant rather than asking twice.';

drop trigger if exists sl_plans_one_pool on public.plans;
create trigger sl_plans_one_pool
  before insert or update on public.plans
  for each row execute function public.sl_plans_one_pool();

comment on column public.plans.audio_minutes is
  'Retired by the one pool: a voice-only call spends video_minutes at the audio burn rate, so this '
  'line sells nothing separate. Kept so older packages stay readable; sl_plans_one_pool folds any '
  'figure written to it into video_minutes and sl_payment_deliver adds it into the single grant.';

revoke execute on function public.sl_account_snapshot(uuid) from anon;
grant execute on function public.sl_account_snapshot(uuid) to authenticated;
