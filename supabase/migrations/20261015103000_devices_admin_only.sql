-- -- A device is the administrator's to revoke, not the account holder's -----
-- The desktop account screen offered a "Remove" button on each of a user's own
-- devices, which was a trap rather than a feature: the binding is permanent by
-- design, so a self-revoked machine could never bind again (the gateway refuses a
-- revoked device and the (user_id, device_id) row stays as a tombstone), and only an
-- administrator could undo it. The action belongs on the admin side, where it already
-- exists with a confirmation step.
--
-- Removing the button alone would leave the door open, because the client call was a
-- plain PostgREST update gated only by this policy. Dropping it makes the database
-- refuse the write for any caller who is not an administrator, so an older installed
-- build, a hand-made request, or a scripted client cannot revoke a device either.
--
-- Nothing that legitimately touches this table stops working: binding, un-binding and
-- last_seen are all written by the gateway through the service role, which bypasses
-- RLS, and the admin panel writes through devices_admin_update / devices_admin_delete
-- guarded by is_admin().

drop policy if exists devices_update_own on public.devices;
drop policy if exists devices_write_own on public.devices;

comment on table public.devices is
  'one row per (account, machine). Written by the gateway service role on a real first call and by admins from the panel; a user may read their own rows and nothing else';
