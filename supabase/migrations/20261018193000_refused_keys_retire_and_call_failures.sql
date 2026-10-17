-- Two things this gateway was unable to do on its own, both of which turned one dead
-- video credential into a customer-visible outage on 2026-10-18:
--
--   1. A credential the provider refuses outright stayed in the pool forever. The
--      picker honours `enabled`, and a failing key gets a ten-minute cooldown, but
--      nothing ever switched a dead key off - so every Start from every account kept
--      burning a round trip on a credential that answers the same 401 every time, and
--      the pool only recovered by falling over one call later.
--   2. When the video engine refused a call, the reason existed only on the
--      customer's own screen, and the app hides engine wording there anyway. So the
--      seller's panel showed a call that started and stopped with nothing written
--      about why, and the only evidence left was "pending" turning into a refund.
--
-- Nothing about the money changes here: a call that never shows a picture is still
-- refunded by the lease, and no minute is booked by either of these functions.

-- ── 1. A refused credential retires itself ────────────────────────────────────
create or replace function public.sl_report_key_use(
  p_key_id   uuid,
  p_provider text,
  p_user     uuid,
  p_outcome  text,
  p_minutes  numeric default 0,
  p_status   integer default null,
  p_detail   text    default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_refused text := 'revoked|unauthoriz|invalid (api )?key|bad key|incorrect api key|permission denied';
  v_dead  boolean := false;
  v_again integer;
  v_peers integer;
begin
  insert into public.key_usage_log (key_id, provider, user_id, outcome, status, detail)
  values (p_key_id, p_provider, p_user, p_outcome, p_status, left(coalesce(p_detail, ''), 400));

  if p_key_id is null then return; end if;

  update public.gateway_keys
     set minutes_today = case when usage_day < v_today then greatest(0, p_minutes)
                              else minutes_today + greatest(0, p_minutes) end,
         usage_day     = v_today,
         last_error    = case when p_outcome = 'fail' then left(coalesce(p_detail, ''), 400) else null end,
         last_error_at = case when p_outcome = 'fail' then now() else last_error_at end
   where id = p_key_id;

  -- A billing refusal (402) is deliberately NOT in here: that says the account behind
  -- the key needs a plan, which he can fix without touching the key, and switching it
  -- off would hide the one message telling him so.
  v_dead := p_outcome = 'fail'
        and (p_status in (401, 403) or coalesce(p_detail, '') ~* v_refused);
  if not v_dead then return; end if;

  -- One refusal can be a hiccup at the provider. Two of the same refusal inside a
  -- quarter of an hour is a dead credential, and the second one retires it.
  select count(*) into v_again
    from public.key_usage_log
   where key_id = p_key_id
     and outcome = 'fail'
     and created_at > now() - interval '15 minutes'
     and (status in (401, 403) or coalesce(detail, '') ~* v_refused);
  if v_again < 2 then return; end if;

  -- Never the last one: a pool that switches itself empty locks every account out,
  -- which is worse than a key that wastes a call.
  select count(*) into v_peers
    from public.gateway_keys k
   where k.enabled
     and k.id <> p_key_id
     and case p_provider
           when 'decart'     then coalesce(k.decart_key, '')     <> ''
           when 'elevenlabs' then coalesce(k.elevenlabs_key, '') <> ''
           else                   coalesce(k.fal_key, '')        <> ''
         end;
  if v_peers = 0 then return; end if;

  update public.gateway_keys set enabled = false where id = p_key_id and enabled;

  insert into public.key_usage_log (key_id, provider, user_id, outcome, status, detail)
  values (p_key_id, p_provider, null, 'fail', p_status,
    'switched off by the gateway after ' || v_again || ' refusals of this credential ('
      || left(coalesce(p_detail, ''), 160) || '). Put a new key in its place, then switch it back on.');
end; $$;

comment on function public.sl_report_key_use(uuid, text, uuid, text, numeric, integer, text) is
  'Books one upstream attempt. A credential the provider refuses twice in 15 minutes is switched off, unless it is the last one for that provider.';

-- ── 2. The engine's own reason, kept where it can be read afterwards ──────────
-- Write-only for a signed-in account: no read policy, so a customer cannot ask what
-- was recorded about them, and the seller reads it in the dashboard like any other
-- table. The app is the only writer, through the function below.
create table if not exists public.call_failures (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  session_id uuid,
  stage      text not null,
  detail     text,
  created_at timestamptz not null default now()
);

-- Supabase's default privileges would otherwise hand this table to every signed-in
-- account: switched on with no policies, and nothing granted, the function above is
-- the only way in.
alter table public.call_failures enable row level security;
revoke all on table public.call_failures from public, anon, authenticated;

comment on table public.call_failures is
  'Why a call the gateway accepted still failed on the customer''s machine, in the engine''s own words. Written by the app, read by the seller.';

create or replace function public.sl_report_call_failure(
  p_session_id uuid,
  p_stage      text,
  p_detail     text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.call_failures (user_id, session_id, stage, detail)
  select auth.uid(), p_session_id,
         left(coalesce(nullif(trim(p_stage), ''), 'unknown'), 40),
         left(coalesce(p_detail, ''), 400)
  where auth.uid() is not null
    and (p_session_id is null
         or exists (select 1 from public.usage_sessions s
                     where s.id = p_session_id and s.user_id = auth.uid()));
$$;

comment on function public.sl_report_call_failure(uuid, text, text) is
  'The app records an engine-side failure against its own session. Refuses anything that is not the caller''s session.';

-- Supabase grants new public functions to anon and authenticated by default; this one
-- is for a signed-in customer only, and anon must not be able to fill the table.
revoke execute on function public.sl_report_call_failure(uuid, text, text) from public, anon;
grant  execute on function public.sl_report_call_failure(uuid, text, text) to authenticated, service_role;
