-- A customer pressing Stop and a video dying on its own look identical in this table: both
-- leave a call that started and a call that ended, and nothing between them saying which hand
-- closed it. Every answer to "did he stop it or did it stop him?" has therefore been an
-- inference from what is missing — a blank with no fault line, a fault line with a picture
-- already on it. That is good enough to diagnose one account and not good enough to put a
-- figure on a panel.
--
-- The app is the only witness, so the app now says the one word that settles it: who closed
-- this call. A press of Stop is 'user'; anything the app itself brought down — his minutes ran
-- out, no picture came and it gave up at the forty-second bound, the transport went away, the
-- video service shut the line — is 'app'.
--
-- A null is not 'app'. It means the report never arrived, which is either a build older than
-- this column or an app that was killed mid-call, and the panel says so rather than guessing.
--
-- Nothing here touches the meter: this writes one column and reads nothing else. Which hand
-- closed the call has no bearing on what the call cost, and the settle path is untouched.

alter table public.usage_sessions
  add column if not exists stopped_by text;

comment on column public.usage_sessions.stopped_by is
  'Who closed this call: user = he pressed Stop, app = the app brought it down, null = the app never reported it.';

create or replace function public.sl_report_call_end(
  p_session_id uuid,
  p_stopped_by text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Same shape as the failure writer: no caller, no session, nothing to say. The app fires
  -- this and walks away, so a refusal must be silent rather than an error he could act on.
  if auth.uid() is null or p_session_id is null then return; end if;

  -- Two words and no others, so a bug in the app cannot write a sentence into a column the
  -- panel reads as a flag.
  if coalesce(p_stopped_by, '') not in ('user', 'app') then return; end if;

  -- His own session only. A session id belonging to another account is dropped rather than
  -- written, exactly as in sl_report_call_failure.
  update public.usage_sessions
     set stopped_by = p_stopped_by
   where id = p_session_id
     and user_id = auth.uid()
     and stopped_by is distinct from p_stopped_by;
end; $$;

revoke execute on function public.sl_report_call_end(uuid, text) from public, anon;
grant  execute on function public.sl_report_call_end(uuid, text) to authenticated, service_role;

comment on function public.sl_report_call_end(uuid, text) is
  'The app records who closed its own call: user or app. Writes one column on the caller''s own session; refuses anything else.';
