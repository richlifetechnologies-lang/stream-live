-- -- One free trial per computer, not one per account ------------------------
-- The free minute is granted the instant an account is created and the only gate was
-- "has this ACCOUNT already had one". Anyone could therefore create a second, third
-- or tenth account on the same machine and draw the trial again each time, and every
-- one of those minutes is real money spent at the provider. He asked for the trial to
-- follow the device: a computer that has already carried a trial gets none.
--
-- The grant fires inside the sign-up trigger, which runs before any device row exists
-- (a device only binds on a first real call), so the device id has to travel with the
-- account itself. The desktop app already computes that id for call binding; it now
-- sends it in the sign-up metadata as well, and the server records which machine the
-- account was created from. No client-side check is trusted: the grant itself refuses
-- when the machine is already in the register.
--
-- An account that arrives with NO device id keeps the old per-account grant, and the
-- reason is deliberate rather than a gap. The builds sitting on customers' machines
-- today do not send one, so refusing them would switch the free trial off for every
-- legitimate new account until each machine updated. A machine that identifies itself
-- is bound to the register; a scripted sign-up that hides its id is not the case this
-- fixes, because the same caller can just as easily forge an id and pass the check
-- anyway. The abuse this does stop is the common one: the app's own sign-up screen,
-- used a second and third time on the same computer.

-- -- 1. Remember the machine an account was created on -----------------------
alter table public.profiles
  add column if not exists signup_device_id text;

comment on column public.profiles.signup_device_id is
  'device id the account was created from, carried in the sign-up metadata; the trial register keys off this';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, signup_device_id)
  values (
    new.id,
    new.email,
    split_part(coalesce(new.email, ''), '@', 1),
    left(nullif(trim(coalesce(new.raw_user_meta_data ->> 'device_id', '')), ''), 128)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- -- 2. The trial register ---------------------------------------------------
-- One row per machine that has already carried a free trial, whichever account drew
-- it. Primary key on the device id is the whole enforcement: the second account on a
-- machine cannot insert the row again and the grant function refuses on its way past
-- it. Admin-readable so a legitimate case (a reformatted PC, a sold-on machine) can be
-- cleared from the panel; never client-readable.
create table if not exists public.device_trial_grants (
  device_id  text primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  minutes    numeric(6,3) not null,
  granted_at timestamptz not null default now()
);

alter table public.device_trial_grants enable row level security;

drop policy if exists dtg_admin_select on public.device_trial_grants;
create policy dtg_admin_select on public.device_trial_grants
  for select using (public.is_admin(auth.uid()));

drop policy if exists dtg_admin_delete on public.device_trial_grants;
create policy dtg_admin_delete on public.device_trial_grants
  for delete using (public.is_admin(auth.uid()));

-- -- 3. Every machine that has already had a trial is spent ------------------
-- Backfilled from the devices that bound and the devices that actually carried calls,
-- limited to accounts that hold a free-trial ledger row. The filter matters: a machine
-- belonging to an account that was never granted a trial must stay eligible, or a
-- legitimate first-time customer would arrive to find its computer already spent.
-- Without the backfill at all, an already abused machine would qualify once more on
-- the first sign-up after this fix.
insert into public.device_trial_grants (device_id, user_id, minutes)
select d.device_id, d.user_id,
       (select l.delta from public.credit_ledger l
         where l.user_id = d.user_id and coalesce(l.reason, '') = 'free trial'
         order by l.created_at limit 1)::numeric(6,3)
  from public.devices d
 where d.device_id is not null and trim(d.device_id) <> ''
   and exists (select 1 from public.credit_ledger l
                where l.user_id = d.user_id and coalesce(l.reason, '') = 'free trial')
on conflict (device_id) do nothing;

insert into public.device_trial_grants (device_id, user_id, minutes)
select u.device_id, u.user_id,
       (select l.delta from public.credit_ledger l
         where l.user_id = u.user_id and coalesce(l.reason, '') = 'free trial'
         order by l.created_at limit 1)::numeric(6,3)
  from public.usage_sessions u
 where u.device_id is not null and trim(u.device_id) <> ''
   and exists (select 1 from public.credit_ledger l
                where l.user_id = u.user_id and coalesce(l.reason, '') = 'free trial')
on conflict (device_id) do nothing;

-- The machine each existing account was created from is unknown history, but any
-- account that drew a trial proves its own machine is spent.
insert into public.device_trial_grants (device_id, user_id, minutes)
select p.signup_device_id, p.id,
       (select l.delta from public.credit_ledger l
         where l.user_id = p.id and coalesce(l.reason, '') = 'free trial'
         order by l.created_at limit 1)::numeric(6,3)
  from public.profiles p
 where p.signup_device_id is not null and trim(p.signup_device_id) <> ''
   and exists (select 1 from public.credit_ledger l
                where l.user_id = p.id and coalesce(l.reason, '') = 'free trial')
on conflict (device_id) do nothing;

-- -- 4. The grant itself ----------------------------------------------------
-- Same subscription provisioning as before, same wallet and ledger writes, same
-- total_credited behaviour from 20261013220000. One gate is added ahead of the money:
-- a machine that is already in the register gets nothing. trial_enabled and the
-- configured minute figure still decide whether any trial exists at all, and a grant
-- that happens to land on a named machine also stamps that machine.
create or replace function public.sl_provision_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan    text;
  v_minutes numeric(6,3);
  v_after   numeric(10,3);
  v_device  text;
begin
  v_plan := coalesce(
    (select id from public.plans where id = 'starter'),
    (select min(id) from public.plans where active),
    (select min(id) from public.plans));
  if v_plan is null then return new; end if;   -- plans not configured yet

  insert into public.subscriptions (user_id, plan_id, status)
  values (new.id, v_plan, 'active')
  on conflict (user_id) do nothing;

  select trial_video_minutes into v_minutes from public.app_config where id = 1;
  if not coalesce((select trial_enabled from public.app_config where id = 1), false)
     or v_minutes is null or v_minutes <= 0 then
    return new;
  end if;

  if exists (select 1 from public.credit_ledger
             where user_id = new.id and coalesce(reason, '') = 'free trial') then
    return new;
  end if;

  v_device := nullif(trim(coalesce(new.signup_device_id, '')), '');

  -- A machine that is already in the register has had its free minute. Done.
  if v_device is not null
     and exists (select 1 from public.device_trial_grants where device_id = v_device) then
    return new;
  end if;

  insert into public.credit_balances (user_id, modality, balance, total_credited)
  values (new.id, 'video', v_minutes, v_minutes)
  on conflict (user_id, modality) do update
     set balance        = round((credit_balances.balance + v_minutes)::numeric, 3),
         total_credited = credit_balances.total_credited + v_minutes,
         updated_at     = now()
  returning balance into v_after;

  insert into public.credit_ledger
    (user_id, modality, kind, delta, balance_after, reason, actor_id)
  values
    (new.id, 'video', 'credit', v_minutes, v_after, 'free trial', null);

  -- Stamp the machine only when it was named, so an anonymous sign-up cannot burn a
  -- device slot it never claimed.
  if v_device is not null then
    insert into public.device_trial_grants (device_id, user_id, minutes)
    values (v_device, new.id, v_minutes)
    on conflict (device_id) do nothing;
  end if;

  update public.subscriptions
     set trial_granted_at = now()
   where user_id = new.id;

  return new;
end; $$;
