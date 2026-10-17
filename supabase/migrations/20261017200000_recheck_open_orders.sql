-- 2026-10-17: give the waiting list an answer.
--
-- A payment that Paystack has taken but this database has not credited is the worst
-- line in the whole product: money has left somebody's wallet and their minutes have
-- not moved. Until now the only things that could notice were the seller's Paystack
-- webhook address (a box typed by hand, in an account this gateway cannot see) and the
-- buyer's own confirm page, which stops asking after a couple of minutes. If both were
-- quiet, the order sat in 'pending' for ever and nothing anywhere said why.
--
-- This adds the missing door: a list of the orders still owed an answer, which any
-- trusted caller can walk and settle directly against Paystack. It is deliberately
-- self-throttling - asking once puts a stamp on the order so the next asking has to wait
-- a minute and a half - because this now runs from the buyer's page, from the app on the
-- payer's own account, and from the seller's Payments tab, and none of them should be
-- able to hammer Paystack with the same question.
--
-- 'paid' is on the list beside 'pending' on purpose. That state means the money was
-- confirmed here but the credit was refused (no account for that email, a package with
-- nothing in it), and re-running the credit is what empties the list without anybody
-- having to edit a database row by hand.

alter table public.payments
  add column if not exists checked_at timestamptz;

comment on column public.payments.checked_at is
  'when this order was last put to Paystack directly; the open-order list will not answer the same question twice inside 90 seconds';

-- Bounded by the same rule the list uses, so the scan stays a walk over a handful of rows
-- however many payments the till has taken.
create index if not exists payments_open_for_recheck_idx
  on public.payments (lower(email), created_at desc)
  where status in ('pending', 'paid');

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: sl_paystack_open_orders — the orders still owed an answer, and none asked
-- about in the last minute and a half. Two weeks is the horizon: after that a
-- still-open order is a job for the seller's own books, not for automatic re-checking.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_paystack_open_orders(
  p_email text    default null,
  p_limit integer default 25
)
returns table (reference text, status text, amount integer, currency text, email text, created_at timestamptz)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  with picked as (
    select id
      from public.payments
     where status in ('pending', 'paid')
       and created_at > now() - interval '14 days'
       and (checked_at is null or checked_at < now() - interval '90 seconds')
       and (p_email is null or lower(email) = lower(p_email))
     order by created_at desc
     limit greatest(1, least(50, coalesce(p_limit, 25)))
  ),
  marked as (
    update public.payments p
       set checked_at = now()
      from picked
     where p.id = picked.id
     returning p.*
  )
  select reference, status, amount, currency, email, created_at from marked;
$$;

comment on function public.sl_paystack_open_orders(text, integer) is
  'lists payment orders that money may have been taken for and minutes have not been granted, stamping each as just asked so re-checking is throttled';

revoke execute on function public.sl_paystack_open_orders(text, integer) from public, anon, authenticated;
grant  execute on function public.sl_paystack_open_orders(text, integer) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- The confirm page is now a receipt, so it needs what a receipt carries: what was
-- bought, what it cost, how it was paid for, this gateway's order number, Paystack's
-- own transaction number, when it happened and which account it went to.
--
-- The account address is masked. Anyone who has the reference can see how much was
-- paid and what it bought; they do not get to harvest the customer's e-mail address
-- out of a page that is open to the internet.
--
-- The 'paid' state is the honest one: Paystack has the money and the credit was
-- refused, so it says the seller has been told rather than promising minutes that
-- are not on their way.
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
    'reference', p.reference,
    'paystack_reference', coalesce(p.paystack_id, ''),
    'plan', coalesce(pl.name, 'that package'),
    'amount', p.amount,
    'currency', p.currency,
    'channel', p.channel,
    'integration', p.paystack_domain,
    'account', case
      when p.email like '%_@_%.__%'
        then left(split_part(p.email, '@', 1), 2) || '***@' || split_part(p.email, '@', 2)
      else coalesce(p.email, '')
    end,
    'grants', coalesce(p.credit_result -> 'grants', '[]'::jsonb),
    'opened_at', to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'paid_at', case when p.paid_at is null then '' else to_char(p.paid_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
    'credited_at', case when p.credited_at is null then '' else to_char(p.credited_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
    'credited', p.credited_at is not null,
    'gone_quiet', p.expired_at is not null,
    'note', coalesce(p.note, ''),
    'message', case
      when p.status = 'credited' then 'Your minutes are in the account.'
      when p.status = 'refunded'
        then 'This payment was refunded to you. The money is on its way back to the card or wallet you paid with, and no minutes were added for it.'
      when p.status = 'paid'
        then 'Paystack has confirmed your money. The minutes could not be added to this account automatically, so the seller has been told and it is being put right. Do not pay again.'
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
