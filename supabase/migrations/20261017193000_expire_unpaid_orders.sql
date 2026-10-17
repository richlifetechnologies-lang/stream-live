-- 2026-10-17: an order nobody pays stops waiting after 30 minutes.
--
-- Paystack only ever reports a payment. A buyer who opens the checkout and walks away
-- produces no call-back at all, so the order in this database would sit in 'pending'
-- for ever: the seller's Payments tab fills with dead lines, and a buyer who returns to
-- their own reference is told "waiting" long after their session has closed.
--
-- This does NOT cancel anything. `status` is untouched, which matters more than the
-- tidiness: a mobile-money payment that clears late still finds a live, creditable order
-- and pays the buyer out. Only a stamp, `expired_at`, is added, and it changes exactly
-- two things - what the seller's waiting list shows, and what the buyer's own page says.
-- An order that later gets paid is credited as normal, stamp or no stamp.

alter table public.payments
  add column if not exists expired_at timestamptz;

-- The sweep looks at open orders and nothing else, so it stays cheap as the table grows.
create index if not exists payments_open_idx
  on public.payments (created_at)
  where status = 'pending' and expired_at is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Stamp the orders that have gone quiet.
--
-- `paid_at` is honoured as well as `created_at`: an order Paystack has already confirmed
-- but whose minutes are still being added is never touched. Runs on the clock below, and
-- safe to call by hand from the panel whenever it wants a fresh list.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_paystack_expire_orders(
  p_after_minutes integer default 30
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  update public.payments
     set expired_at = now()
   where status = 'pending'
     and expired_at is null
     and coalesce(paid_at, created_at) < now() - make_interval(mins => greatest(1, p_after_minutes));

  get diagnostics v_n = row_count;
  return v_n;
end; $$;

comment on function public.sl_paystack_expire_orders(integer) is
  'stamps unpaid, un-followed-up payment orders after the given minutes so they leave the seller''s waiting list; never changes status, so a late payment still credits';

revoke execute on function public.sl_paystack_expire_orders(integer)
  from public, anon, authenticated;
grant execute on function public.sl_paystack_expire_orders(integer) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- The buyer's poll now says so when their own order has stopped waiting, instead of
-- asking them to wait for money that is never coming. Same safety as before: it is a
-- message, not a status.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_paystack_status(p_reference text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'ok', true,
    'status', p.status,
    'plan', coalesce(pl.name, 'that package'),
    'amount', p.amount,
    'currency', p.currency,
    'channel', p.channel,
    'credited', p.credited_at is not null,
    'gone_quiet', p.expired_at is not null,
    'message', case
      when p.status = 'credited' then 'Your minutes are in the account.'
      when p.status = 'paid'     then 'The payment reached us and your minutes are being added.'
      when p.status = 'failed'   then 'That payment did not complete. Nothing was charged.'
      when p.expired_at is not null
        then 'No payment has arrived for this order, so it is no longer being held open.'
      when p.channel = 'mobile_money'
        then 'Waiting for you to approve the payment on your phone.'
      else 'Waiting for the payment to confirm.'
    end
  )
  from public.payments p
  left join public.plans pl on pl.id = p.plan_id
  where p.reference = p_reference;
$$;

revoke execute on function public.sl_paystack_status(text) from public, anon, authenticated;
grant  execute on function public.sl_paystack_status(text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Every five minutes. Same pattern as the lease reaper: the job is replaced, not
-- duplicated, and the migration still applies on a project without pg_cron.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not installed on this project - order expiry will not run on a schedule';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'stream_live_expire_orders') then
    perform cron.unschedule('stream_live_expire_orders');
  end if;

  perform cron.schedule(
    'stream_live_expire_orders',
    '*/5 * * * *',
    'select public.sl_paystack_expire_orders(30)'
  );
  raise notice 'unpaid payment orders expire after 30 minutes, checked every 5 minutes';
end; $$;
