-- A customer cannot declare themselves the owner ----------------------------
-- profiles_update_own (20260930000000_init.sql) lets a signed-in person rewrite their own
-- account row, and a row policy can only ever ask WHO is writing, never WHICH COLUMNS it
-- may touch. The administrator flag lives on that same row, and the key drawer is readable
-- by anyone the is_admin function answers true for - with the provider keys stored in plain
-- words. So an app that saves its own account record can save "make me the administrator"
-- in the same write, and then read every key this product buys video and voice with.
--
-- Nothing in the shipped app writes to profiles at all: the name on an account is taken
-- from the email address when the person signs up. The one column a person has any business
-- changing on their own row is the name they are shown as, so that is all this allows.
--
-- A BEFORE UPDATE trigger is what does the pinning, and it runs before the policy is
-- checked. The write is still allowed, but the owner's columns keep the owner's values. That
-- shape matters: it cannot break a legitimate save, so it needs no new sentence on a
-- customer's screen for a rejection no honest customer will ever meet.
--
-- The pin only applies when the write carries a customer's own sign-in. A gateway call made
-- with the service key has no signed-in user at all, and an administrator is exempt by name,
-- so the panel, the network record and every other security-definer function keep writing
-- exactly as they do today.
--
-- The sign-in is therefore read from the request's own claim and only used when it is shaped
-- like an account. It is not handed to auth.uid(): that function casts the claim to an
-- account address, and the service key's claim is the word for the key itself, not an
-- address. A policy is never consulted on a service-key write, so nothing alive today meets
-- that cast - but a trigger runs on every write, including the gateway's. Asking auth.uid()
-- here would have turned the network record into an error.
--
-- The policy is then tightened as a second lock behind the trigger, so that if the trigger is
-- ever dropped the escalation is still impossible.

create or replace function public.sl_lock_owner_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  -- Whatever the request claims to be signed in as, from either place Supabase puts it.
  -- The whole claims object is only parsed when it is shaped like one, because this
  -- function runs on every write to the table and a cast that failed would fail the write.
  --
  -- Declared empty and filled in the body rather than declared with their values. The
  -- managed database endpoint that runs migrations breaks a declaration list whose items
  -- carry initialisers, and this exact shape is what the other two migrations this morning
  -- used and got through on the first try. Same words, same moment of reading.
  v_sub     text;
  v_claims  text;
begin
  v_sub    := nullif(current_setting('request.jwt.claim.sub', true), '');
  v_claims := nullif(current_setting('request.jwt.claims', true), '');
  if v_sub is null and v_claims is not null and left(btrim(v_claims), 1) = '{' then
    v_sub := nullif(v_claims::jsonb ->> 'sub', '');
  end if;
  -- No claim, or a claim that is not an account address: this is the gateway or the dashboard
  -- writing, and every column keeps whatever it was given.
  if v_sub is null or v_sub !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return new;
  end if;
  -- An account that is already an administrator may still change its own row's flags.
  if public.is_admin(v_sub::uuid) then
    return new;
  end if;
  -- Built from the row as it already stands, with one column taken from what was written,
  -- so a column added to profiles later is protected by default rather than exposed.
  new := jsonb_populate_record(
    NULL::public.profiles,
    to_jsonb(old) || jsonb_build_object('display_name', to_jsonb(new.display_name))
  );
  return new;
end; $$;

comment on function public.sl_lock_owner_columns() is
  'Before-update guard: for a signed-in non-administrator, every column of profiles except '
  'display_name is put back to what it already was. A write with no account claim behind it '
  '(the gateway, the panel, the dashboard) is passed through untouched. Add a customer-'
  'editable column to the jsonb_build_object list only when the app really lets a person set it.';

drop trigger if exists profiles_owner_columns_locked on public.profiles;
create trigger profiles_owner_columns_locked before update on public.profiles
  for each row execute function public.sl_lock_owner_columns();

-- Same rule, stated where a policy can state it: a writer who is not already an
-- administrator may not leave the flag set on the row they write. is_admin is security
-- definer over profiles, so naming it inside a profiles policy cannot recurse.
--
-- The flag is named bare, not as new.is_admin. A trigger gets a record called new to read what
-- was written; a policy has no such word, and asking for one is refused as a column that does
-- not exist. Bare columns inside a write policy already mean the values being written, which is
-- exactly what is wanted here.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id and (not is_admin or public.is_admin(auth.uid())));
