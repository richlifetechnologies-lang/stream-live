-- -- A dead call must stop costing the customer --
-- When a lease is reaped (crash, closed tab, lost network) the old body set
-- ended_at = lease_expires_at, so the meter billed the whole TTL as if the
-- customer had stayed on air. Proof from 2026-10-15: a paid call opened 19:10:16,
-- received its last heartbeat 19:11:51, was closed at 19:13:51 (expiry) and the
-- books settled at 19:15:00 - so about two minutes nobody streamed were billed,
-- 2.4 wallet minutes at the 1.2x rate.
--
-- lease_started_at is written by every renew, so at reap time it is the newest
-- moment the server can prove the call was live. Billing now stops there, plus a
-- grace long enough to cover a heartbeat that failed to land while the customer
-- really did keep streaming (the app ends its own call once a heartbeat fails, so
-- this is a ceiling, not an expectation).
--
-- Nothing here changes what a customer sees: still only his wallet balance, never
-- a rate and never a second "real minutes" figure.

alter table public.app_config
  add column if not exists lease_grace_seconds integer not null default 60;

create or replace function public.sl_reap_sessions(p_user uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s        public.usage_sessions;
  v_grace  integer;
  v_stop   timestamptz;
  n        integer := 0;
begin
  select coalesce(lease_grace_seconds, 60) into v_grace from public.app_config where id = 1;

  for s in
    select * from public.usage_sessions
    where ended_at is null and not settled
      and lease_expires_at is not null
      and lease_expires_at < now()
      and (p_user is null or user_id = p_user)
    for update
  loop
    v_stop := coalesce(s.lease_started_at, s.started_at) + make_interval(secs => v_grace);
    if v_stop > s.lease_expires_at then v_stop := s.lease_expires_at; end if;

    -- The row is closed at the proven moment, and the same value is handed to the
    -- settle so its own least(now, lease_expires_at) reads the capped window.
    s.lease_expires_at := v_stop;
    s.ended_at         := v_stop;

    update public.usage_sessions
       set ended_at = v_stop, lease_expires_at = v_stop, settled = true, pending_debit = 0
     where id = s.id;
    perform public.sl_settle_window(s);
    n := n + 1;
  end loop;
  return n;
end; $$;

-- -- The sweeper ran every 5 minutes, so a refund could sit out of reach that long --
do $$
declare
  v_job bigint;
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not installed on this project - the reaper still runs on the next Start and from the panel';
    return;
  end if;
  select jobid into v_job from cron.job where jobname = 'stream_live_reap_leases' limit 1;
  if v_job is not null then
    perform cron.unschedule(v_job);
  end if;
  perform cron.schedule('stream_live_reap_leases', '* * * * *', 'select public.sl_reap_sessions(null)');
  raise notice 'lease reaper now runs every minute';
end $$;
