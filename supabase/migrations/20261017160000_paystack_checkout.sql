-- ─────────────────────────────────────────────────────────────────────────────
-- Paid online through Paystack: card and Ghana mobile money.
--
-- Until now every minute was typed in by hand on the admin panel. This makes a
-- package buyable with a card or with mobile money, both taken by Paystack: the
-- buyer pays on Paystack's own screen, Paystack tells the gateway, and the
-- gateway credits the minutes.
--
-- Two ways in, because Paystack offers both:
--   A. paystack-checkout (this repo's own page): we open the order, so we know the
--      package and the account before the card is touched, and we can refuse a
--      payment that could not be delivered.
--   B. A payment page built inside Paystack's dashboard — no page of ours at all.
--      Nothing is known until the money lands, so the amount has to identify the
--      package and the payer's email has to identify the account.
--
-- Three rules shape the whole design:
--   1. Minutes move ONLY when Paystack says money actually arrived, and only after
--      the gateway asks Paystack itself about that transaction. A webhook body on
--      its own is never trusted, because anyone can POST one.
--   2. A payment reference is unique and can be credited once, so Paystack's
--      retries — which are routine — cannot pay twice. The existing
--      sl_grant_credits dedupe window is 15 seconds and a webhook can land minutes
--      later, so it cannot be the guard here.
--   3. Nothing here touches the modality switches. If the administrator turned
--      audio off for an account, a purchase does not turn it back on: the minutes
--      land and wait for his switch.
--
-- Currency: Paystack rejects USD for this merchant ("Currency not supported by
-- merchant", proven against the live API in test mode on 2026-10-17), so the buyer
-- is charged in Ghana cedis. Nothing about the packages changes: plans.price_cents
-- stays the dollar figure the app shows, and the cedi amount a buyer pays is that
-- dollar figure multiplied by app_config.paystack_ghs_per_usd at the moment the
-- order is opened. Change the rate on that one row and every price on the buy page
-- moves with it — no package has to be re-typed.
--
-- plans.price_ghp exists as an override for the odd package where he wants a round
-- cedi figure instead of the converted one. Left null it is ignored.
--
-- Payment methods: app_config.paystack_channels decides which of the two the buy
-- page offers, and the order carries the one the buyer chose. Which mobile money
-- networks a buyer is then offered — MTN MoMo, Telecel Cash, AT Money, Vodafone
-- Cash — is Paystack's own decision, made from his account settings on their side
-- and shown on their screen; we deliberately do not keep a network list, because a
-- list we maintain can only ever disagree with what Paystack actually allows.
-- ─────────────────────────────────────────────────────────────────────────────

-- Pesewas charged for this package. Null means "use the conversion",
-- which is the normal case; set it only to pin one package to its own figure.
alter table public.plans
  add column if not exists price_ghp integer check (price_ghp is null or price_ghp > 0);

comment on column public.plans.price_ghp is
  'optional override: pesewas charged through Paystack. null = plans.price_cents converted at app_config.paystack_ghs_per_usd.';

-- One switch for the whole rail, so the checkout page can be taken down without
-- deleting packages or unpublishing a page.
alter table public.app_config
  add column if not exists paystack_enabled boolean not null default false;

-- Which of the two ways to pay the buy page offers. Both by default; take one away
-- without touching any code:
--   update public.app_config set paystack_channels = array['card'] where id = 1;
alter table public.app_config
  add column if not exists paystack_channels text[] not null default array['card','mobile_money']
    check (paystack_channels <@ array['card','mobile_money']);

comment on column public.app_config.paystack_channels is
  'payment methods the buy page offers: card, mobile_money, or both.';

-- The dollar-to-cedi figure every price is worked out from. 12 is the rate he set
-- on 2026-10-17; he can change it here without touching a package:
--   update public.app_config set paystack_ghs_per_usd = 13 where id = 1;
alter table public.app_config
  add column if not exists paystack_ghs_per_usd numeric(8,2) not null default 12
    check (paystack_ghs_per_usd > 0);

comment on column public.app_config.paystack_ghs_per_usd is
  'cedis per one US dollar, used to convert every plans.price_cents into the amount charged.';

-- ── payments: one row per online payment, however it was started ─────────────
create table if not exists public.payments (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  provider        text   not null default 'paystack'
                    check (provider in ('paystack','paystack_page')),
  reference       text   not null unique,          -- ours for route A, Paystack's for route B
  access_code     text,                            -- Paystack's handle on the attempt
  paystack_id     text,                            -- its own id, once paid
  paystack_domain text   not null default 'test' check (paystack_domain in ('test','live')),
  user_id         uuid   references public.profiles (id) on delete set null,
  email           text   not null,                 -- the address the buyer typed
  plan_id         text   references public.plans (id),
  channel         text   not null default 'card'
                    check (channel in ('card','mobile_money','bank','ussd','qr','other')),
  amount          integer not null check (amount > 0),   -- pesewas
  currency        text   not null default 'GHS' check (currency = 'GHS'),
  status          text   not null default 'pending'
                    check (status in ('pending','failed','paid','credited','refunded')),
  paid_at         timestamptz,
  credited_at     timestamptz,
  credit_result   jsonb,                           -- what was granted, to whom
  note            text,                            -- why it stopped, in plain words
  raw             jsonb                            -- last transaction body from Paystack
);

create index if not exists payments_status_created_idx on public.payments (status, created_at desc);
create index if not exists payments_email_idx on public.payments (lower(email));

drop trigger if exists payments_touch on public.payments;
create trigger payments_touch before update on public.payments
  for each row execute function public.touch_updated_at();

-- Locked down: the Edge Functions reach it with the service role, which ignores
-- RLS entirely. Admins can read it from the panel; nobody else sees anything.
alter table public.payments enable row level security;

drop policy if exists payments_admin_read on public.payments;
create policy payments_admin_read on public.payments
  for select to authenticated using (public.is_admin(auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- Shared: what one package costs on a card, in pesewas.
-- Every path — the buy page, the order, the payment-page matcher — asks this one
-- function, so a package can never be shown at one price and charged at another.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_plan_ghp(p_plan_id text)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    pl.price_ghp,
    -- price_cents and price_ghp are both hundredths of their currency, so the
    -- dollar figure times the rate is already pesewas: $9 at 12 = GH₵108 = 10800.
    case when coalesce(pl.price_cents, 0) <= 0 then null
         else greatest(100, round(pl.price_cents::numeric * ac.paystack_ghs_per_usd))::integer end
  )
  from public.plans pl
  cross join public.app_config ac
  where pl.id = p_plan_id and ac.id = 1;
$$;

comment on function public.sl_plan_ghp(text) is
  'pesewas charged for one package: plans.price_ghp if set, otherwise plans.price_cents converted at app_config.paystack_ghs_per_usd.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Shared: how the money actually arrived, in one of our own words.
-- Paystack's own channel values vary by country and change over time
-- (mobile_money, momo, ussd_mobile_money, bank_transfer_gh, h24_bank_transfer,
-- qr, card ...), so they are filed under six labels here rather than kept raw.
-- Anything unknown is called 'other' instead of being guessed at.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_paystack_channel(p_raw text)
returns text
language sql
immutable
as $$
  select case
    when p_raw ~* 'mobile_money|momo'        then 'mobile_money'
    when p_raw = 'card'                      then 'card'
    when p_raw = 'qr'                        then 'qr'
    when p_raw = 'ussd'                      then 'ussd'
    when p_raw ~* 'bank'                     then 'bank'
    else 'other'
  end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: sl_paystack_packages — the shelf the buyer sees.
-- Every package that is switched on in the app and carries minutes is buyable, so
-- the buy page can never fall behind the Plans list. Unpriced packages (price_cents
-- 0 with no override) cannot be charged for and are left off.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_paystack_packages()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'ok', true,
    'enabled', coalesce((select ac.paystack_enabled from public.app_config ac where ac.id = 1), false),
    'currency', 'GHS',
    'ghs_per_usd', coalesce((select ac.paystack_ghs_per_usd from public.app_config ac where ac.id = 1), 12),
    'channels', coalesce((select ac.paystack_channels from public.app_config ac where ac.id = 1), array['card','mobile_money']),
    'packages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pl.id, 'name', pl.name, 'blurb', pl.blurb, 'includes', pl.includes,
        'features', pl.features,
        'price_cents', coalesce(pl.price_cents, 0),
        'price_ghp', public.sl_plan_ghp(pl.id),
        'video_minutes', coalesce(pl.video_minutes, 0),
        'audio_minutes', coalesce(pl.audio_minutes, 0),
        'video_audio_minutes', coalesce(pl.video_audio_minutes, 0),
        'max_devices', pl.max_devices
      ) order by public.sl_plan_ghp(pl.id), pl.name)
      from public.plans pl
      where pl.active
        and coalesce(pl.video_minutes, 0) + coalesce(pl.audio_minutes, 0)
            + coalesce(pl.video_audio_minutes, 0) > 0
        and public.sl_plan_ghp(pl.id) is not null
    ), '[]'::jsonb)
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Shared: sl_payment_deliver — turn one package into minutes on one account.
-- Called by both entry points, so a package can never be delivered two different
-- ways. Raises on a failed grant, which rolls the whole settle back and lets
-- Paystack's retry finish the job.
-- The three-argument form is dropped first: with the channel argument defaulted,
-- leaving both alive would make every call ambiguous.
drop function if exists public.sl_payment_deliver(uuid, text, text);
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_payment_deliver(
  p_user      uuid,
  p_plan_id   text,
  p_reference text,
  p_channel   text default 'card'   -- how the money arrived, for the ledger line
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan     public.plans;
  v_grants   jsonb := '[]'::jsonb;
  v_res      jsonb;
  v_minutes  integer;
  v_modality modality_flag;
  v_reason   text;
begin
  select * into v_plan from public.plans where id = p_plan_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'plan_missing');
  end if;

  v_reason := case p_channel
    when 'mobile_money' then 'Mobile money payment'
    when 'card'         then 'Card payment'
    else                     'Online payment'
  end || ' - ' || v_plan.name || ' (' || p_reference || ')';

  -- One grant per bucket the package actually carries. A package with zero audio
  -- minutes grants no audio minutes at all.
  for v_modality, v_minutes in
    select * from (values
      ('video'::modality_flag,       coalesce(v_plan.video_minutes, 0)),
      ('audio'::modality_flag,       coalesce(v_plan.audio_minutes, 0)),
      ('video_audio'::modality_flag, coalesce(v_plan.video_audio_minutes, 0))
    ) as b(modality, minutes) where b.minutes > 0
  loop
    v_res := public.sl_grant_credits(v_user, v_modality, v_minutes, v_reason, null, null);
    if v_res is null or v_res->>'ok' is distinct from 'true' then
      raise exception 'grant failed for %: %', v_modality,
        coalesce(v_res->>'error', 'no answer from the credit function');
    end if;
    v_grants := v_grants || jsonb_build_array(jsonb_build_object(
      'modality', v_modality::text, 'minutes', v_minutes, 'balance', v_res->'balance'));
  end loop;

  if v_grants = '[]'::jsonb then
    return jsonb_build_object('ok', false, 'error', 'plan_has_no_minutes');
  end if;

  -- A payment is the clearest possible signal that an account is in use, so the
  -- subscription row is pointed at the package just bought and made active.
  -- Modality switches and the device ceiling are deliberately left alone.
  insert into public.subscriptions (user_id, plan_id, status)
  values (v_user, v_plan.id, 'active')
  on conflict (user_id) do update
    set plan_id          = excluded.plan_id,
        status           = 'active',
        billing_provider = 'paystack',
        billing_ref      = p_reference,
        updated_at       = now();

  return jsonb_build_object('ok', true, 'user_id', v_user, 'plan', v_plan.name,
                            'grants', v_grants, 'reason', v_reason);
end; $$;

revoke execute on function public.sl_payment_deliver(uuid, text, text, text) from public, anon, authenticated;
grant  execute on function public.sl_payment_deliver(uuid, text, text, text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: sl_paystack_settle — route A. Credits an order this gateway opened.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_paystack_settle(
  p_reference text,
  p_txn       jsonb default '{}'::jsonb   -- what Paystack itself returned for this reference
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pay      public.payments;
  v_user     uuid;
  v_status   text;
  v_amount   integer;
  v_currency text;
  v_domain   text;
  v_channel  text;
  v_paid_at  timestamptz;
  v_res      jsonb;
begin
  if p_reference is null or length(trim(p_reference)) = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_reference');
  end if;

  -- Lock the row first: two webhooks for one payment arrive at the same moment and
  -- only the loser of this lock should find credited_at already set.
  select * into v_pay from public.payments where reference = p_reference for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown_reference');
  end if;

  if v_pay.credited_at is not null then
    return jsonb_build_object('ok', true, 'deduped', true, 'reference', p_reference,
                              'result', v_pay.credit_result);
  end if;

  if v_pay.status in ('failed', 'refunded') then
    return jsonb_build_object('ok', false, 'error', 'payment_' || v_pay.status, 'reference', p_reference);
  end if;

  v_status   := lower(coalesce(nullif(p_txn->>'status', ''), 'success'));
  v_amount   := nullif(p_txn->>'amount', '')::numeric::integer;
  v_currency := upper(coalesce(nullif(p_txn->>'currency', ''), v_pay.currency));
  v_domain   := lower(coalesce(nullif(p_txn->>'domain', ''), v_pay.paystack_domain));
  -- Paystack's answer wins over what the buyer clicked, because it is the one
  -- thing that knows whether the money really came from a card or a wallet.
  v_channel  := public.sl_paystack_channel(
    lower(coalesce(nullif(p_txn->>'channel', ''), v_pay.channel)));
  -- Paystack's own timestamps are ISO strings; anything else is ignored rather than
  -- thrown, because a bad timestamp must not stop a real payment crediting.
  v_paid_at  := coalesce(
    case when coalesce(p_txn->>'paid_at', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
         then nullif(p_txn->>'paid_at', '')::timestamptz end,
    now());

  if v_status <> 'success' then
    update public.payments
       set status = 'failed', note = 'Paystack says this transaction is ' || v_status,
           raw = coalesce(raw, '{}'::jsonb) || p_txn
     where id = v_pay.id;
    return jsonb_build_object('ok', false, 'error', 'not_paid', 'status', v_status);
  end if;

  -- Money, currency and integration mode all have to agree with the order we
  -- opened. The domain check is what stops test-mode money crediting a real
  -- account; the amount check stops a GH₵1 payment crediting a GH₵790 package.
  if v_amount is not null and v_amount <> v_pay.amount then
    update public.payments set note = 'amount mismatch: charged ' || coalesce(v_amount::text, '?')
      || ', expected ' || v_pay.amount, raw = coalesce(raw, '{}'::jsonb) || p_txn where id = v_pay.id;
    return jsonb_build_object('ok', false, 'error', 'amount_mismatch', 'reference', p_reference);
  end if;
  if v_currency <> v_pay.currency then
    update public.payments set note = 'currency mismatch: ' || v_currency,
      raw = coalesce(raw, '{}'::jsonb) || p_txn where id = v_pay.id;
    return jsonb_build_object('ok', false, 'error', 'currency_mismatch', 'reference', p_reference);
  end if;
  if v_domain <> v_pay.paystack_domain then
    update public.payments set note = 'integration mismatch: ' || v_domain,
      raw = coalesce(raw, '{}'::jsonb) || p_txn where id = v_pay.id;
    return jsonb_build_object('ok', false, 'error', 'domain_mismatch', 'reference', p_reference);
  end if;

  -- The buyer's account. They typed the address themselves, so it may simply be
  -- wrong; the payment is kept as 'paid' for the administrator to resolve rather
  -- than silently dropping money that was taken.
  v_user := v_pay.user_id;
  if v_user is null then
    select id into v_user from public.profiles where lower(email) = lower(v_pay.email) limit 1;
  end if;
  if v_user is null then
    update public.payments set status = 'paid', paid_at = v_paid_at,
      note = 'paid, but no account uses that email address',
      raw = coalesce(raw, '{}'::jsonb) || p_txn
     where id = v_pay.id;
    return jsonb_build_object('ok', false, 'error', 'no_account_for_email',
                              'email', v_pay.email, 'reference', p_reference);
  end if;

  v_res := public.sl_payment_deliver(v_user, v_pay.plan_id, p_reference, v_channel);
  if v_res->>'ok' is distinct from 'true' then
    update public.payments set status = 'paid', paid_at = v_paid_at, channel = v_channel,
      note = 'paid, but nothing could be credited: ' || coalesce(v_res->>'error', 'unknown'),
      raw = coalesce(raw, '{}'::jsonb) || p_txn
     where id = v_pay.id;
    return v_res || jsonb_build_object('reference', p_reference);
  end if;

  update public.payments
     set status        = 'credited',
         user_id       = v_user,
         channel       = v_channel,
         paid_at       = v_paid_at,
         credited_at   = now(),
         paystack_id   = coalesce(nullif(p_txn->>'id', ''), v_pay.paystack_id),
         credit_result = v_res,
         note          = null,
         raw           = coalesce(raw, '{}'::jsonb) || p_txn
   where id = v_pay.id;

  return v_res || jsonb_build_object('reference', p_reference);
end; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: sl_paystack_page_credit — route B. A payment page built in Paystack's own
-- dashboard, so this gateway saw nothing until the money arrived. The amount says
-- which package was bought and the payer's email says whose account it is; when
-- either is unclear the money is recorded and left for the administrator, never
-- guessed at.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sl_paystack_page_credit(
  p_reference text,
  p_txn       jsonb default '{}'::jsonb   -- what Paystack itself returned for this reference
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pay      public.payments;
  v_email    text;
  v_amount   integer;
  v_currency text;
  v_domain   text;
  v_channel  text;
  v_status   text;
  v_paid_at  timestamptz;
  v_match    integer;
  v_plan     text;
  v_user     uuid;
  v_id       uuid;
  v_res      jsonb;
begin
  if p_reference is null or p_reference !~ '^[A-Za-z0-9_.-]{6,64}$' then
    return jsonb_build_object('ok', false, 'error', 'bad_reference');
  end if;

  v_status   := lower(coalesce(nullif(p_txn->>'status', ''), 'success'));
  v_amount   := nullif(p_txn->>'amount', '')::numeric::integer;
  v_currency := upper(coalesce(nullif(p_txn->>'currency', ''), 'GHS'));
  v_domain   := lower(coalesce(nullif(p_txn->>'domain', ''), 'live'));
  v_channel  := public.sl_paystack_channel(lower(coalesce(p_txn->>'channel', '')));
  v_email    := lower(trim(coalesce(p_txn #>> '{customer,email}', '')));
  v_paid_at  := case when coalesce(p_txn->>'paid_at', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                     then nullif(p_txn->>'paid_at', '')::timestamptz else now() end;

  if v_status <> 'success' then return jsonb_build_object('ok', false, 'error', 'not_paid'); end if;
  if v_amount is null          then return jsonb_build_object('ok', false, 'error', 'no_amount'); end if;
  if v_currency <> 'GHS'       then return jsonb_build_object('ok', false, 'error', 'currency_unsupported', 'currency', v_currency); end if;
  if v_domain <> 'live'        then return jsonb_build_object('ok', false, 'error', 'test_money', 'domain', v_domain); end if;
  if v_email = '' then
    return jsonb_build_object('ok', false, 'error', 'no_email_on_transaction');
  end if;

  -- Record it, or discover it was already recorded. The unique reference is the
  -- whole defence against Paystack delivering the same success twice.
  insert into public.payments
    (reference, provider, email, amount, currency, channel, paystack_domain, status, paid_at, raw)
  values
    (p_reference, 'paystack_page', v_email, v_amount, 'GHS', v_channel, 'live', 'pending', v_paid_at, p_txn)
  on conflict (reference) do nothing
  returning id into v_id;

  if v_id is null then
    select * into v_pay from public.payments where reference = p_reference;
    return jsonb_build_object('ok', v_pay.credited_at is not null, 'deduped', true,
                              'status', v_pay.status, 'reference', p_reference,
                              'result', v_pay.credit_result);
  end if;

  select count(*) into v_match from public.plans pl
    where pl.active and public.sl_plan_ghp(pl.id) = v_amount;
  if v_match = 0 then
    update public.payments set status = 'paid',
      note = 'paid, but no package is priced at exactly this amount'
     where id = v_id;
    return jsonb_build_object('ok', false, 'error', 'no_package_at_this_price',
                              'amount', v_amount, 'reference', p_reference);
  end if;
  if v_match > 1 then
    update public.payments set status = 'paid',
      note = 'paid, but two packages share this price, so the order is ambiguous'
     where id = v_id;
    return jsonb_build_object('ok', false, 'error', 'ambiguous_price',
                              'amount', v_amount, 'reference', p_reference);
  end if;

  select pl.id into v_plan from public.plans pl
    where pl.active and public.sl_plan_ghp(pl.id) = v_amount limit 1;

  update public.payments set plan_id = v_plan where id = v_id;

  select id into v_user from public.profiles where lower(email) = v_email limit 1;
  if v_user is null then
    update public.payments set status = 'paid',
      note = 'paid, but no account uses that email address'
     where id = v_id;
    return jsonb_build_object('ok', false, 'error', 'no_account_for_email',
                              'email', v_email, 'reference', p_reference);
  end if;

  v_res := public.sl_payment_deliver(v_user, v_plan, p_reference, v_channel);
  if v_res->>'ok' is distinct from 'true' then
    update public.payments set status = 'paid',
      note = 'paid, but nothing could be credited: ' || coalesce(v_res->>'error', 'unknown')
     where id = v_id;
    return v_res || jsonb_build_object('reference', p_reference);
  end if;

  update public.payments
     set status = 'credited', user_id = v_user, credited_at = now(),
         paystack_id = coalesce(nullif(p_txn->>'id', ''), paystack_id),
         credit_result = v_res, note = null
   where id = v_id;

  return v_res || jsonb_build_object('reference', p_reference);
end; $$;

-- Only the service role may call any of these. They move minutes; a browser must
-- never be able to ask.
revoke execute on function public.sl_plan_ghp(text) from public, anon, authenticated;
grant  execute on function public.sl_plan_ghp(text) to service_role;
revoke execute on function public.sl_paystack_packages() from public, anon, authenticated;
grant  execute on function public.sl_paystack_packages() to service_role;
revoke execute on function public.sl_paystack_settle(text, jsonb) from public, anon, authenticated;
grant  execute on function public.sl_paystack_settle(text, jsonb) to service_role;
revoke execute on function public.sl_paystack_page_credit(text, jsonb) from public, anon, authenticated;
grant  execute on function public.sl_paystack_page_credit(text, jsonb) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: sl_paystack_status — what the checkout page polls after the buyer comes
-- back. A reference is an unguessable random token, and this answers only about
-- that one order: no email, no balance, no history.
--
-- The join to plans is a LEFT join on purpose: an administrator is allowed to
-- switch a package off or rename it while somebody's payment is in flight, and the
-- buyer must still be able to see their own result.
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
    'message', case
      when p.status = 'credited' then 'Your minutes are in the account.'
      when p.status = 'paid'     then 'The payment reached us and your minutes are being added.'
      when p.status = 'failed'   then 'That payment did not complete. Nothing was charged.'
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
