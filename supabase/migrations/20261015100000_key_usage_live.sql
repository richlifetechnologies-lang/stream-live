-- The Key pool tab shows each key's "Today / cap" from gateway_keys.minutes_today,
-- and the gateway reads that same column to decide whether a key has hit its
-- daily_minute_cap. Only one thing ever wrote it: the prepaid chunk booked when a
-- call starts. Everything a call burned after that first chunk settled into
-- usage_sessions and never touched the key. So the tab froze at the opening minutes
-- of a call however long the call ran, and the daily cap under-counted by the same
-- amount, which let an over-cap key keep taking traffic.
--
-- Booking now happens where the money is actually booked: the window settle. Each
-- settle adds its charged minutes against the key that served the call, so the
-- figure the panel shows and the figure that gates the cap are both the real bill.

-- -- 1. A session must remember which paid-video key served it ----------------
-- The Decart trial sessions already carried decart_key_id; the fal path had nothing,
-- which is why settle could not attribute its minutes back to a key.
alter table public.usage_sessions
  add column if not exists fal_key_id uuid references public.gateway_keys (id) on delete set null;

create index if not exists usage_sessions_fal_key_idx on public.usage_sessions (fal_key_id);

-- -- 2. Add billed minutes to a key's rolling daily counter -------------------
-- Same UTC rollover rule sl_pick_keys applies when it reads the counter, so a
-- counter stamped yesterday starts today at this window's minutes rather than
-- yesterday's total plus this window.
create or replace function public.sl_book_key_minutes(p_key_id uuid, p_minutes numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
begin
  if p_key_id is null or coalesce(p_minutes, 0) <= 0 then return; end if;

  update public.gateway_keys
     set minutes_today = case when usage_day < v_today then round(p_minutes::numeric, 3)
                              else round((minutes_today + p_minutes)::numeric, 3) end,
         usage_day     = v_today
   where id = p_key_id;
end; $$;

-- -- 3. Settle books against the key that served the window -------------------
-- Body is the current sl_settle_window from 20261013180000_meter_from_first_frame
-- with one added step. Delivered-first billing is untouched: a window that carried
-- no frame still charges nothing, so it books nothing against the key either.
-- Decart sessions are excluded because their minutes are budgeted per trial key
-- through sl_book_decart_minutes and sl_release_decart_minutes.
create or replace function public.sl_settle_window(p_session public.usage_sessions)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_stop   timestamptz;
  v_base   timestamptz;
  v_real   numeric;
  v_charge numeric;
  v_refund numeric;
  v_mult   numeric;
begin
  insert into public.credit_balances (user_id, modality, balance)
  values (p_session.user_id, p_session.modality, 0)
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

-- -- 4. The panel must never show yesterday's counter as today's --------------
-- sl_pick_keys already treats a counter stamped on an earlier UTC day as zero; the
-- view showed the raw number, so a key looked capped for the whole morning after a
-- long night of calls. Same columns in the same order, so the view keeps its shape.
create or replace view public.admin_key_health
with (security_invoker = true) as
select k.id, k.label, k.enabled, k.priority, k.daily_minute_cap,
       case when k.usage_day < (now() at time zone 'utc')::date then 0::numeric(10,3)
            else k.minutes_today end as minutes_today,
       k.usage_day,
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

grant select on public.admin_key_health to authenticated;

-- -- 5. Only the gateway may book a key --------------------------------------
revoke execute on function public.sl_book_key_minutes(uuid, numeric) from public, anon, authenticated;
grant execute on function public.sl_book_key_minutes(uuid, numeric) to service_role;
