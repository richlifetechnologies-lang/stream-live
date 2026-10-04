-- Fix: the init select policies embedded `exists (select 1 from public.profiles ...)`
-- inside their own USING clause. Reading profiles from a profiles policy (and from
-- any policy whose inner read hits profiles_select_own) recurses, so Postgres raised
-- "infinite recursion detected in policy for relation profiles" and EVERY client
-- SELECT on profiles/subscriptions/devices/usage_sessions failed. The security-definer
-- helper public.is_admin(uid) (20261001) reads profiles as owner, bypassing RLS, so
-- using it here removes the recursion.

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (
    auth.uid() = id
    or public.is_admin(auth.uid())
  );

drop policy if exists subs_select_own on public.subscriptions;
create policy subs_select_own on public.subscriptions
  for select using (
    auth.uid() = user_id
    or public.is_admin(auth.uid())
  );

drop policy if exists devices_select_own on public.devices;
create policy devices_select_own on public.devices
  for select using (
    auth.uid() = user_id
    or public.is_admin(auth.uid())
  );

drop policy if exists usage_select_own on public.usage_sessions;
create policy usage_select_own on public.usage_sessions
  for select using (
    auth.uid() = user_id
    or public.is_admin(auth.uid())
  );
