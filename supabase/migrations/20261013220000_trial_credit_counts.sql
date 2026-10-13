-- -- The free minute must show up as money that was given ------------------
-- The admin panel's LIFETIME column reads credit_balances.total_credited against
-- total_spent. The sign-up grant wrote the ledger row for the free minute but
-- inserted the wallet row without touching total_credited, so the only grant that
-- ever counted was one that landed on an existing row. An account that spent its
-- whole trial therefore reads "+0.1 / -1.1": it looks like the call borrowed a
-- minute the account never had, when in fact 1.000 minutes were granted and 1.000
-- were spent. Nothing about the billing itself was wrong and no customer was
-- over-charged - only the lifetime figure was lying.
--
-- Nothing here changes who may start a call. sl_account_is_paid reads the ledger,
-- not this column, so a trial account still runs on the trial engine after the
-- backfill.

-- -- 1. Count the grant on the insert path too -------------------------------
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

  update public.subscriptions
     set trial_granted_at = now()
   where user_id = new.id;

  return new;
end; $$;

-- -- 2. Put the lifetime figures back where the ledger says they belong ------
-- The ledger is the record of what actually moved, so rebuild total_credited from
-- it rather than guessing which rows the old insert path missed. Buckets with no
-- credit rows keep whatever they hold; this only corrects a column that drifted
-- away from its own history.
update public.credit_balances cb
   set total_credited = round(l.credited::numeric, 3),
       updated_at = now()
  from (select user_id, modality, sum(delta) as credited
          from public.credit_ledger
         where kind = 'credit'
        group by user_id, modality) l
 where l.user_id = cb.user_id
   and l.modality = cb.modality
   and cb.total_credited is distinct from round(l.credited::numeric, 3);
