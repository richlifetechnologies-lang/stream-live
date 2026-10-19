-- -- Record the network an account's calls come from -------------------------
-- The trial register keys off a code the app builds from the computer's NAME, so two
-- customers whose machines happen to carry the same name look like ONE computer to the
-- grant, and the second of them is refused a free minute she never used. Nothing in this
-- database could tell that apart from one person simply creating a second account on the
-- same machine, because no request ever kept the address it came from. The two cases now
-- read differently: same computer code and same network is one place, so the refusal is
-- correct; same computer code from two distant networks is a name collision, and the
-- account that got nothing is a customer who was wrongly denied.
--
-- The address cannot be taken at sign-up itself: that request goes to the auth service
-- and never reaches this gateway, and the token it hands back carries no address. So the
-- stamp happens on the account's first call to the gateway, ahead of every gate — a call
-- that was refused is exactly the case that has to be diagnosable afterwards.

alter table public.profiles
  add column if not exists network_first_ip  text,
  add column if not exists network_first_at  timestamptz,
  add column if not exists network_last_ip   text,
  add column if not exists network_last_at   timestamptz;

comment on column public.profiles.network_first_ip is
  'address the gateway first saw this account call from; taken on its first call, not at sign-up';
comment on column public.profiles.network_last_ip is
  'most recent address this account called from, refreshed at most once an hour';

create or replace function public.sl_note_network(p_user uuid, p_ip text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user is null then return; end if;
  -- The address arrives in a header, so anything that is not shaped like a bare
  -- address is dropped rather than stored and printed later.
  if p_ip is null or p_ip !~ '^[0-9a-fA-F:.]{3,45}$' then return; end if;
  -- Every call would otherwise rewrite the same two pairs of columns.
  if exists (select 1 from public.profiles
              where id = p_user and network_last_ip = p_ip
                and network_last_at > now() - interval '1 hour') then
    return;
  end if;
  update public.profiles
     set network_last_ip  = p_ip,
         network_last_at  = now(),
         network_first_ip = coalesce(network_first_ip, p_ip),
         network_first_at = coalesce(network_first_at, now())
   where id = p_user;
end; $$;

-- Only the gateway functions may write this. A customer must not be able to choose the
-- address on record, and an anonymous caller must not be able to fill it in at all.
revoke all on function public.sl_note_network(uuid, text) from public, anon, authenticated;
grant execute on function public.sl_note_network(uuid, text) to service_role;
