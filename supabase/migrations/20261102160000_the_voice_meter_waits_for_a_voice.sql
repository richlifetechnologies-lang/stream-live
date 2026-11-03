-- -- The voice meter waits for a voice -------------------------------------------------
-- A voice-only cloning call has one product: the cloned voice that comes back from the voice
-- service. Until a piece of it actually reaches the customer's machine he has received nothing,
-- so from this file the meter does not run.
--
-- The picture rule has said this since the first-frame migration, and audio was deliberately left
-- out of it then because nothing in the app could tell the server a voice had started. That signal
-- exists now: the app stamps the lease the moment cloned audio is on its way to the cable, so the
-- gate that protects a blank video call protects a silent voice call too. An account that was
-- credited and whose clone never answered was still being drained minute by minute, and the panel
-- had no way to see it, because the drain was invisible by design until this file.
--
-- What changes:
--   * sl_settle_window bills nothing while a lease has never sent its delivery stamp - any modality.
--     The prepaid chunk is refunded exactly as a blank video window is refunded, so the minutes come
--     back to the same pool they left.
--   * The 40-second no-delivery bound that closes a blank video call now closes a silent voice call
--     too, and answers 'no_voice' for it so the customer reads a voice sentence rather than being
--     told about a picture he never asked for. This is what stops the other half of the same fault:
--     an audio lease that owes nothing would otherwise renew for ever and hold the voice service
--     open on the seller's account, unbilled.
--   * A lease still waiting for its delivery stamp reports no countdown (funded_seconds null), which
--     is how the app already handles a video call that has not shown a frame.
--
-- What does NOT change: the burn rates, the packages, the prices, the one-pool wallet map, the
-- engine choice, the 40-second number itself, the retry ladder, and the way a call that DOES deliver
-- is metered. A Video + Audio call keeps its own rule: its first frame stamps the lease and the meter
-- starts then, because on that tab a moving picture is delivery whether the customer has spoken yet
-- or not - and if it were not stamped, this bound would close a working picture call.

-- -- 1. The settle window: nothing owed before delivery -----------------------------------
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

  if p_session.media_started_at is null then
    -- Nothing was delivered in this window, whatever kind of call it was, so nothing is owed.
    -- The chunk this lease set aside is refunded below, which is the whole point: the minute
    -- comes back.
    v_real := 0;
  else
    -- Only the first window can be clamped forward. Later windows start after the delivery
    -- already arrived, and lease_started_at already tracks the last settle.
    if p_session.media_started_at > v_base then v_base := p_session.media_started_at; end if;
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

-- -- 2. The lease: a silent voice call is closed, not renewed for ever ---------------------
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

  -- NO-DELIVERY BOUND ------------------------------------------------------
  -- Every modality now, not video alone: a voice lease that bills nothing would otherwise renew
  -- for ever and keep the voice service open on the seller's account for a customer who has heard
  -- nothing. Placed after the window above has been settled and refunded, so closing here owes
  -- nothing and gives back everything this lease had set aside. The 40 seconds is unchanged - it
  -- is the number measured on this database and chosen on 1 November 2026, and it lands inside
  -- the app's own 45-second check-in.
  if s.media_started_at is null
     and s.started_at < now() - interval '40 seconds' then
    update public.usage_sessions
       set ended_at = now(), settled = true, lease_expires_at = now(), pending_debit = 0
     where id = p_session_id;
    return r || jsonb_build_object(
      'ok', true, 'ended', true,
      'reason', case when s.modality = 'audio' then 'no_voice' else 'no_picture' end,
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
  -- A window is billed from the delivery stamp, so until that stamp lands nothing is being
  -- consumed and no deadline is owed: null comes back, and the app keeps the countdown it
  -- already knows how to make. An unlimited bucket is never cut short, so it is null too.
  v_mult := coalesce(s.multiplier, public.current_burn_rate(s.modality));
  if v_unlimited or s.media_started_at is null then
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
  'Renew, end, or stamp the first delivered second of an open lease. Any lease - picture or '
  'voice-only - that has never sent that stamp is closed instead of renewed once it is older '
  'than 40 seconds, charged nothing, with every window refunded.';

comment on function public.sl_settle_window(public.usage_sessions) is
  'Settle one lease window. Bills from media_started_at and nothing at all before it, for every '
  'modality; refunds whatever the prepaid chunk did not buy.';
