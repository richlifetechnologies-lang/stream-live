-- The app now records what the video service answered when a call was refused
-- (call_failures, added the same evening). For that record to be worth anything, the
-- seller has to be able to read it without writing SQL, so the Key pool tab of the admin
-- panel shows it next to the credential health — when a customer reports "cannot start",
-- the two rows that explain it are beside each other.
--
-- Reads stay admin-only: a regular account can still write about its own calls and read
-- nothing at all from this table.

create index if not exists call_failures_recent_idx
  on public.call_failures (created_at desc);

-- `to authenticated` is not decoration: without it a policy covers every role, including
-- anon/service, and the grant below would then be the only thing standing between the
-- publishable key and this log.
drop policy if exists call_failures_admin_select on public.call_failures;
create policy call_failures_admin_select on public.call_failures
  for select to authenticated using (public.is_admin(auth.uid()));

-- Select only. The app's writer path remains the security-definer function below, so no
-- account can insert or change a row here directly.
grant select on public.call_failures to authenticated;

comment on policy call_failures_admin_select on public.call_failures is
  'Only an admin reads the refused-call log; the app writes through sl_report_call_failure.';

-- A handful of customers, several attempts each, every day: this table would grow forever
-- for a log that is only ever interesting for the last day or two. The writer prunes
-- anything older than two months as it goes, which is the cheapest place to do it.
create or replace function public.sl_report_call_failure(
  p_session_id uuid,
  p_stage      text,
  p_detail     text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.call_failures where created_at < now() - interval '60 days';

  if auth.uid() is null then return; end if;

  -- The caller's own session, or none. A session id belonging to another account is
  -- dropped rather than written, so nobody can file a note against someone else's call.
  if p_session_id is not null and not exists (
       select 1 from public.usage_sessions s
        where s.id = p_session_id and s.user_id = auth.uid()
     ) then return; end if;

  insert into public.call_failures (user_id, session_id, stage, detail)
  values (
    auth.uid(),
    p_session_id,
    left(coalesce(nullif(trim(p_stage), ''), 'unknown'), 40),
    left(coalesce(p_detail, ''), 400)
  );
end; $$;

comment on function public.sl_report_call_failure(uuid, text, text) is
  'The app records an engine-side failure against its own session. Refuses anything that is not the caller''s session.';
