-- Deleting an account. The row vanishes, the money trail should not.
--
-- Every app table hangs off profiles(id) with on delete cascade, so removing the auth
-- user sweeps the account clean by itself — which is exactly why the removal needs a
-- witness. Without one, an account that was deleted by mistake (or in anger) leaves no
-- sign it ever existed: no email, no balance, no history in any view the panel has.
-- This table is that witness, written by the gateway's own role before the delete runs.

create table if not exists public.account_deletions (
  id          bigint generated always as identity primary key,
  deleted_at  timestamptz not null default now(),
  actor_id    uuid,          -- no FK: an administrator who leaves later must not erase the record
  actor_email text,
  user_id     uuid        not null,
  email       text,
  created_at  timestamptz,   -- when the deleted account first signed up
  balances    jsonb,         -- {video, audio, video_audio} minutes still in the buckets
  minutes     numeric,       -- lifetime minutes credited back to the account
  reason      text
);

-- Only the gateway writes it. A signed-in administrator may read it; no policy would
-- let a regular account see anyone's row, not even their own.
alter table public.account_deletions enable row level security;

drop policy if exists "admins read account deletions" on public.account_deletions;
create policy "admins read account deletions"
  on public.account_deletions for select
  using (public.is_admin(auth.uid()));
