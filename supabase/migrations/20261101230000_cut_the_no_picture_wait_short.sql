-- -- Cut the no-picture wait short -------------------------------------------------------
-- A video call that never shows a picture is already closed by your own rule and refunded in
-- full, so the customer pays nothing. But the picture engine is running the whole time that
-- rule waits, and every second of it is billed to the workspace. This changes the wait, and
-- nothing else about the rule: still closed, still charged nothing, still every window refunded.

-- Why 40 and not 45, 60 or 30: the bound can only be acted on when the app checks in, and it
-- checks in every 45 seconds. A 45-second bound lands exactly on that tick and usually misses it,
-- so the call waits for the following check-in and is closed at about 90 - today's number. A
-- 60-second bound does the same thing. Anything under 45 is acted on at the FIRST check-in, so
-- that is the only band that actually halves the bill; and inside that band the number costs the
-- same, so the largest one is taken: 40 leaves five seconds of the first window as grace.

-- The number was measured on this database, not guessed. The 63 fal video calls that ever stamped
-- a first frame, timed from the second their lease opened (read on 1 November 2026):
--   average 9 seconds to the first frame, and 58 of the 63 inside 18 seconds;
--   slowest on record 54 seconds - one call, opened on 1 November itself.
-- So this bound cuts exactly one of those 63 calls, and it is a call that had already sat 45
-- seconds with a blank screen at his first check-in. What that customer loses is 9 further seconds
-- of waiting for a picture; what stops is half the engine time on every call that never delivers
-- one - this month 239 seconds of billed compute on three blank calls, about 135 under this rule.
-- The owner was shown that 54-second call by name and chose the trade on 1 November 2026.

-- What did NOT move here:
--   * the app's retry ladder (its three asks and the 10s/30s waits) and the wait the server
--     names for itself, which the app obeys - none of that is in this function;
--   * the per-machine hold, the lines-busy ceiling, the burn rates, the packages, the prices;
--   * 'media_started_at' itself: the first frame still stamps the call and the meter still only
--     starts counting from that stamp, so a call that does connect is untouched;
--   * what a customer reads: the same sentence about the picture never arriving and the minutes
--     being given back, only reached a minute sooner.
-- A call that has been open 40 seconds with nothing on screen has already failed far more often
-- than it has recovered - and the go-live window proves that off your own records, for every
-- call that did show a picture in your whole history, BEFORE it puts this file up. It counts how
-- many of those calls took longer than this bound to show their first frame; if more than one
-- did, the window holds this file back and says what it found instead of applying it.

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
     and s.started_at < now() - interval '40 seconds' then
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

comment on function public.sl_lease(uuid, text) is
  'Renew, end, or stamp the first frame of an open lease. A video lease that has never sent '
  'the frame stamp is closed instead of renewed once it is older than 40 seconds - still '
  'charged nothing, with every window refunded.';

