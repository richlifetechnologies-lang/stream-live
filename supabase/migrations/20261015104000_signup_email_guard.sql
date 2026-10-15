-- -- Account creation must refuse an address that cannot exist ---------------
-- The sign-up screen collected the email and handed it straight to auth with no
-- checking of its own, so anything at all was accepted as an account. An address that
-- is not even a candidate for delivery is worthless twice over: the owner cannot be
-- reached, and the account is one more row that can be pointed at the free trial.
--
-- The screen now checks the shape before it asks, and this trigger is the part that
-- cannot be skipped: it runs on the auth row itself, so a direct API call, an older
-- build or a scripted client is refused by the database as well. Only a syntactically
-- impossible address is rejected here, because a real-looking typo is not something a
-- format rule can see - only a delivered confirmation link proves an address.
--
-- Self-signup itself stays open (product rule); this refuses malformed addresses, not
-- people, and the account-creation switch below is unchanged.

create or replace function public.sl_guard_signup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.app_config where id = 1 and signup_enabled = false) then
    raise exception 'account creation is temporarily disabled';
  end if;

  -- A null email belongs to a non-email identity and is left alone; anything shaped
  -- like an address has to be a plausible one.
  if new.email is not null and new.email !~ '^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$' then
    raise exception 'that email address is not valid';
  end if;

  return new;
end; $$;
