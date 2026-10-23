-- -- A call that never shows a picture cannot live on renewals -----------------
-- The rule that no frame means no charge is kept whole here, and it is worth being exact
-- about why: the meter starts on the app's own word. sl_lease's 'media' action is the only
-- thing in this database that ever writes media_started_at, and the app fires it the instant
-- the first remote frame paints, retrying while the call is live. Until that stamp lands,
-- every window settles at zero and hands the prepaid chunk straight back - which is what
-- makes a broken start cost the customer nothing.
--
-- The same kindness is the hole. An app that is opened up and edited simply never says it.
-- Then every window is free, the pre-debit is refunded every time, and 'renew' keeps the seat
-- alive: video streaming on the paid service, metered at zero, for as long as whoever edited
-- it feels like. Nothing about the account's balance, plan or device limits stops it.
--
-- So the word is trusted for a bounded time instead of for ever. The heartbeat is every 45
-- seconds, measured failures of this kind die in about six, and a first frame that has not
-- arrived two heartbeats into a call is a call that is already over: at that point the
-- session is closed exactly the way an ordinary end closes it - settled, nothing owed, every
-- window refunded, the seat given back. An honest customer cannot reach this line: their call
-- is billed from the frame, and a call that shows a frame has already sent the stamp.
--
-- It composes with the machine pacing gate rather than fighting it. A closed session with no
-- frame in it is one of the dead passes that gate counts, so an edited app that restarts the
-- call to buy another free stretch is held for the escalating window like any other retry.
--
-- This is a copy of sl_lease as it stands (last rewritten in 20261013180000), with one new
-- block between the ordinary end and the renew pre-debit. The renew path before and after it
-- is untouched, the 'media' and 'end' actions are untouched, and a create-or-replace keeps
-- the EXECUTE grants service_role already has.

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

  return r || jsonb_build_object(
    'ok', true, 'ended', false,
    'balance', (select balance from public.credit_balances
                where user_id = s.user_id and modality = s.modality),
    'chunk_minutes', v_chunk,
    'lease_ttl_seconds', v_cfg.lease_ttl_seconds,
    'unlimited', v_unlimited,
    'modality', s.modality::text);
end; $$;

comment on function public.sl_lease(uuid, text) is
  'Renew, end, or stamp the first frame of an open lease. A video lease that has never sent '
  'the frame stamp is closed instead of renewed once it is older than 90 seconds - still '
  'charged nothing, with every window refunded.';
