-- 2026-10-30: two shelves — one for the customers paying in cedis at home, one for everyone else.
--
-- The till has one price column and one set of payment doors. The doors are the problem:
-- mobile money on this page means three Ghanaian networks, so a buyer in Colombia or Abidjan
-- is offered ways to pay and not one of them can take his money. He sees options, picks none
-- of them, and leaves.
--
-- So the shelf is split. A Ghana package and an international package are two rows of the
-- same table, told apart by `market`: the international row carries its own price because
-- selling across a border is not the same cost, and it is offered by card only.
--
-- NOTHING IN THIS FILE READS THE CUSTOMER'S ADDRESS. The owner refused that outright: a
-- Ghanaian on a VPN would be shown foreign prices and a foreigner visiting Accra would be
-- shown the wrong ones, and he is not going to lose a sale to a guess about somebody's
-- network. The shelf comes from the customer's own tap on the Plans screen. The app remembers
-- that computer's answer, and it is written against his account with `market_source = 'tap'`
-- so the next machine he signs in on already knows. An administrator can set it too, which is
-- the only other way this column moves. No package list, no price and no payment door on the
-- server is ever chosen from an IP, a route, a timezone or a header.
--
-- The payment doors are then enforced HERE, not on the page. Ghana is mobile money only —
-- every Ghanaian already has a wallet, and a card form on his till is a form he cannot use.
-- The international shelf is card only, because no foreign wallet settles into this account.
-- A till that only knows the package the buyer clicked can therefore never be talked into the
-- wrong door: the package's own `market` decides which channel the gateway will accept, and
-- anything else is refused before Paystack is asked for a checkout.
--
-- Every package that exists today is a Ghana package, so the international shelf would
-- otherwise be empty and a foreign buyer would see a list of nothing. This migration copies
-- each Ghana row to its own international row at the SAME figures, which he then reprices in
-- the admin panel one package at a time. Each twin carries `mirror_of`, and the buyer is told
-- plainly that he is being shown the Ghana price — the sentence goes away by itself the moment
-- he types his own price for that package, because the flag only means something while the two
-- figures are still the same number.
--
-- The `country` column is for the SELLER'S EYES ONLY, as a flag beside the account, so he can
-- see where the money is coming from. It is written three ways and none of them asks a third
-- party anything: the customer's own Ghana tap, the seller himself, and the two-letter value
-- the edge runtime already carries on the request as `cf-ipcountry` — the same free header the
-- network stamp reads today, so it costs no call and no money. NO GEOIP LOOKUP IS MADE HERE
-- and none should be added: a lookup is a paid request, it is wrong for anybody on a VPN, and
-- it is not needed, because the customer says which shelf he wants. If a deployment never sets
-- that header the column simply stays whatever the tap or the seller left it. The flag is
-- display: it never chooses a price, a package list or a payment door.
--
-- `i18n` carries the seller's own words in the buyer's language: package names and whatever
-- explanation he writes for each one, which no dictionary of interface labels can know.
-- Absent language, absent key, empty string — all mean the same thing and fall back to
-- English rather than showing a buyer a blank card.

-- ─── the shelf a package sits on ────────────────────────────────────────────────────────
alter table public.plans
  add column if not exists market text not null default 'gh'
    check (market in ('gh', 'intl'));

comment on column public.plans.market is
  'which shelf this package is sold from: gh = paid in cedis by mobile money only, intl = paid by card only. The customer picks the shelf himself by tapping it in the app; no address, no geo lookup and no header decides it, and the gateway takes the door from this column rather than from whatever the page was shown.';

-- ─── the international twin of a Ghana package ──────────────────────────────────────────
-- Set when this migration copies his Ghana catalogue abroad, and left null for a package he
-- made on purpose. It is kept rather than inferred from the price so that a hand-made
-- international package that happens to cost what a Ghana one does is never mislabelled.
-- The buyer's note is this flag AND the two figures still matching, so re-pricing the row is
-- the only thing he has to do to make that sentence disappear — no switch to remember to flip.
alter table public.plans
  add column if not exists mirror_of text references public.plans (id) on delete set null;

comment on column public.plans.mirror_of is
  'for an international row: the Ghana package it was copied from. The till prints a note on such a package while its price is still its original''s, and the note goes away on its own once the seller prices that row himself. null for any package he made on purpose.';

-- ─── the seller's own words, per language ───────────────────────────────────────────────
alter table public.plans
  add column if not exists i18n jsonb not null default '{}'::jsonb;

comment on column public.plans.i18n is
  'the package name and blurb in the buyer''s language, keyed by language code: {"es":{"name":"...","blurb":"..."}}. Anything missing falls back to the English row.';

-- ─── which shelf an account chose, and who said so ──────────────────────────────────────
alter table public.profiles
  add column if not exists market text check (market in ('gh', 'intl')),
  add column if not exists market_source text check (market_source in ('tap', 'admin')),
  add column if not exists market_at timestamptz,
  add column if not exists country text;

comment on column public.profiles.market is
  'the shelf this account last chose for itself. null until he chooses one, and the app defaults its own list to Ghana in that case. Remembering it is a convenience: it is not what gates a payment — the package''s own plans.market does.';
comment on column public.profiles.market_source is
  'tap = the customer chose it himself on the Plans screen, admin = the seller set it in the control panel. There is no third answer, because nothing reads his address. While this says admin a further tap is recorded nowhere: the seller''s word outranks the machine''s until he sets the shelf again (sl_note_market with p_source ''tap'' hands the choice back).';
comment on column public.profiles.market_at is
  'when the shelf was last chosen, so the seller can see whether an account has said anything yet.';
comment on column public.profiles.country is
  'two-letter code shown as a flag beside this account, FOR THE SELLER ONLY. Written by the customer''s own Ghana tap, by the seller, or from the cf-ipcountry header the edge runtime already carries. Never a GeoIP answer, and never used to pick a price, a package list or a payment door — a wrong flag costs the buyer nothing.';

-- ─── the shelf and the flag, written on the server ──────────────────────────────────────
-- The narrow door every server-side write goes through: the till recording a tap it was
-- handed, the gateway stamping the flag from its own request header, the control panel
-- setting either by hand. Values it will not take are ignored rather than guessed at, so a
-- stale or half-filled call cannot blank out what the account already says.
create or replace function public.sl_note_market(
  p_user uuid,
  p_market text default null,
  p_source text default null,
  p_country text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_market  text;
  v_source  text;
  v_country text;
begin
  if p_user is null then
    return jsonb_build_object('ok', false, 'error', 'no_account');
  end if;

  v_market  := case when p_market in ('gh', 'intl') then p_market end;
  v_source  := case when p_source in ('tap', 'admin') then p_source end;
  -- A country is two letters or nothing at all: this column is printed as a flag, and a
  -- browser once sent the whole of somebody's address as its language.
  v_country := case when coalesce(p_country, '') ~ '^[A-Za-z][A-Za-z]$'
                    then lower(p_country) end;

  -- A tap is the customer's own choice and says nothing about which country he is standing
  -- in. Only the seller's word, or a gateway stamp, may put a country on the row here.
  if v_source = 'tap' then
    v_country := null;
  end if;

  if v_market is null and v_country is null then
    return jsonb_build_object('ok', false, 'error', 'nothing_said');
  end if;

  update public.profiles set
    market        = coalesce(v_market, market),
    market_source = case when v_market is not null
                        then coalesce(v_source, market_source, 'tap')
                        else market_source end,
    country       = coalesce(v_country, country),
    market_at     = case when v_market is not null then now() else market_at end
  where id = p_user
    -- The seller's word outranks a tap: while the row says 'admin', a further tap is not
    -- written down behind his back. He releases it by setting the shelf again.
    and (v_source = 'admin' or market_source is distinct from 'admin');

  return jsonb_build_object('ok', true, 'user_id', p_user,
                            'market', v_market, 'source', v_source, 'country', v_country);
end; $$;

comment on function public.sl_note_market is
  'remembers the shelf this account chose, who chose it, and the flag shown to the seller. Service-role only: the app cannot write its own account row, so a tap is recorded on the server and a gateway stamps the country from the header it was already given. Nothing in here routes a customer.';

revoke all on function public.sl_note_market(uuid, text, text, text) from public;
revoke all on function public.sl_note_market(uuid, text, text, text) from anon;
revoke all on function public.sl_note_market(uuid, text, text, text) from authenticated;
grant execute on function public.sl_note_market(uuid, text, text, text) to service_role;

-- ─── the customer's own tap, from inside the app ────────────────────────────────────────
-- The account row is not writable by the account holder (see sl_lock_owner_columns), so his
-- choice goes through this door instead. It can only ever move the shelf on the row that
-- signed in, it can only answer 'tap', and it cannot put words in the seller's mouth. Tapping
-- the Ghana shelf IS a country statement he made himself, so that one is recorded; tapping the
-- international shelf is not — an American and a Nigerian both tap the same word.
create or replace function public.sl_choose_market(p_market text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not signed in');
  end if;
  if p_market not in ('gh', 'intl') then
    return jsonb_build_object('ok', false, 'error', 'which shelf is it: gh or intl');
  end if;

  -- The one marker the account-locking trigger knows. Set for this transaction only, and put
  -- back the moment it ends, so it cannot be left switched on for a later write.
  perform set_config('sl.shelf_tap', 'on', true);

  update public.profiles set
    market        = p_market,
    market_source = 'tap',
    country       = case when p_market = 'gh' then 'gh' else country end,
    market_at     = now()
  where id = v_uid
    and (market_source is distinct from 'admin');

  perform set_config('sl.shelf_tap', '', true);

  return jsonb_build_object('ok', true, 'market', p_market, 'source', 'tap');
end; $$;

comment on function public.sl_choose_market is
  'the buyer''s own shelf choice, written against his own account only, always recorded as a tap, and never as the seller''s word. It moves nothing but which list he is shown: the payment door comes from the package he picks, not from this column.';

revoke all on function public.sl_choose_market(text) from public;
revoke all on function public.sl_choose_market(text) from anon;
grant execute on function public.sl_choose_market(text) to authenticated;

-- ─── letting that one write through the account lock ────────────────────────────────────
-- profiles_owner_columns_locked (20261022210000) rebuilds a customer's write from the row as
-- it stood, keeping only display_name — which is right, and which would also have quietly
-- eaten the shelf tap, because the trigger reads WHO signed in from the request's own claim and
-- that claim is still there inside a security-definer function. This is the same function with
-- one narrow exception bolted on, and the exception is not a permission an app can ask for:
-- the marker is a setting only a function on this server can make, and even with it the write
-- is only passed through when it is the signer's own row, a shelf that exists, and the word
-- 'tap'. A direct REST write of these columns is still silently reverted, so an app can no more
-- claim to be an administrator's decision than it can claim to be the administrator.
create or replace function public.sl_lock_owner_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
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
  -- The shelf tap, and nothing else. Built from the row as it stands with the three shelf
  -- columns taken from what was written — country is NOT among them, so no customer write can
  -- put a country on his own account.
  if coalesce(current_setting('sl.shelf_tap', true), '') = 'on'
     and new.id = v_sub::uuid
     and new.market in ('gh', 'intl')
     and new.market_source = 'tap' then
    new := jsonb_populate_record(
      null::public.profiles,
      to_jsonb(old) || jsonb_build_object(
        'display_name',  to_jsonb(new.display_name),
        'market',        to_jsonb(new.market),
        'market_source', to_jsonb(new.market_source),
        'market_at',     to_jsonb(new.market_at)
      )
    );
    return new;
  end if;
  -- Built from the row as it already stands, with one column taken from what was written,
  -- so a column added to profiles later is protected by default rather than exposed.
  new := jsonb_populate_record(
    null::public.profiles,
    to_jsonb(old) || jsonb_build_object('display_name', to_jsonb(new.display_name))
  );
  return new;
end; $$;

comment on function public.sl_lock_owner_columns is
  'Before-update guard: for a signed-in non-administrator, every column of profiles except '
  'display_name is put back to what it already was — with one exception, the shelf tap, which '
  'passes only when it is his own row, a real shelf, the source word tap, and the write came '
  'from inside sl_choose_market. A write with no account claim behind it (the gateway, the '
  'panel, the dashboard) is passed through untouched. Add a customer-editable column to the '
  'jsonb_build_object list only when the app really lets a person set it.';

-- ─── the flag, from the header the request already carries ──────────────────────────────
-- sl_note_network (20261018235900) stamps the address an account first called from. The same
-- request carries the platform's own two-letter country value, and taking it costs nothing: no
-- lookup, no call, no money. It fills the flag ONLY where nothing has said a country yet, so
-- the customer's own tap and the seller's own word are never overruled by a machine reading —
-- and a reading that is wrong for a customer on a VPN is wrong only on a screen the seller
-- glances at.
drop function if exists public.sl_note_network(uuid, text);

create or replace function public.sl_note_network(
  p_user uuid,
  p_ip text,
  p_country text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user is null then return; end if;
  -- The address arrives in a header, so anything that is not shaped like a bare
  -- address is dropped rather than stored and printed later.
  if p_ip is null or p_ip !~ '^[0-9a-fA-F:.]{3,45}$' then
    -- No address still leaves the flag worth taking, and that is the whole of what this
    -- call is allowed to do with it.
    update public.profiles
       set country = coalesce(country, case when coalesce(p_country, '') ~ '^[A-Za-z][A-Za-z]$'
                                            then upper(p_country) end)
     where id = p_user;
    return;
  end if;
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
         network_first_at = coalesce(network_first_at, now()),
         country          = coalesce(country, case when coalesce(p_country, '') ~ '^[A-Za-z][A-Za-z]$'
                                                   then upper(p_country) end)
   where id = p_user;
end; $$;

comment on function public.sl_note_network(uuid, text, text) is
  'stamps the address a gateway call arrived from, and — display only — the two-letter country the edge runtime already put on that request. The third argument is never asked of a GeoIP service and nothing chooses a price, a shelf or a payment door from it. Existing behaviour is unchanged: only the first reading of a country is written, so a tap or the seller''s own word always wins.';

-- Only the gateway functions may write this. A customer must not be able to choose the
-- address on record, and an anonymous caller must not be able to fill it in at all.
revoke all on function public.sl_note_network(uuid, text, text) from public, anon, authenticated;
grant execute on function public.sl_note_network(uuid, text, text) to service_role;

-- ─── the same catalogue, offered abroad — WITHOUT writing a single row ───────────────────
-- Every package the seller has today is a Ghana package, so a foreign buyer would land on an
-- empty list. He must still see his packages, and he must see them at the same figures until
-- he prices them himself.
--
-- This is deliberately NOT done by inserting a copied row per package. His installed apps read
-- the plans table directly, with no shelf in the question, so every copied row would appear in
-- an app that has not updated yet as a SECOND card beside the one it was copied from — the same
-- package twice, one of them with no price on it. That is a broken Plans screen for a customer
-- who did nothing wrong.
--
-- So the abroad shelf is a VIEW of his rows, decided where the shelf is asked for:
--   a package that has an active row of its own on the abroad shelf is offered as that row;
--   a package that has none is offered on the abroad shelf as itself, at its own figure, and
--   the reader marks it 'mirrored' so the panel can say out loud that abroad is still paying
--   the home price.
-- The moment he presses "Send abroad" in the panel and types his own price, that package stops
-- falling back and its own row answers. Nothing about his existing rows changes, and nothing in
-- this migration writes to his catalogue.

-- ─── the shelf, read for one market ─────────────────────────────────────────────────────
-- The no-argument form is dropped, not left beside this one: with both arguments defaulted,
-- a call that names none would match two functions and Postgres would refuse it as ambiguous —
-- and every installed app that has not updated yet asks exactly that question. With the
-- defaults it answers the same as before: the Ghana shelf, cedis, mobile money.
drop function if exists public.sl_paystack_packages();

create or replace function public.sl_paystack_packages(p_market text default 'gh', p_lang text default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with shelf as (
    select pl.id, pl.name, pl.blurb, pl.includes, pl.features, pl.price_cents,
           pl.video_minutes, pl.audio_minutes, pl.video_audio_minutes, pl.max_devices,
           pl.market, pl.mirror_of,
           coalesce(pl.i18n -> lower(left(nullif(p_lang, ''), 2)) ->> 'name',  pl.name)  as shown_name,
           coalesce(pl.i18n -> lower(left(nullif(p_lang, ''), 2)) ->> 'blurb', pl.blurb) as shown_blurb,
           x.price_ghp,
           m.price_ghp as original_price_ghp,
           -- A home package answering for the abroad shelf, because the seller has not made his
           -- own abroad row for it yet. Flagged so every reader can say the figure is still the
           -- Ghana one, and so the card is not printed as if it were a priced-up package.
           p_market = 'intl' and pl.market is distinct from 'intl' as falls_back,
           x.price_ghp is not null
             and coalesce(pl.video_minutes, 0) + coalesce(pl.audio_minutes, 0)
                 + coalesce(pl.video_audio_minutes, 0) > 0 as buyable
    from public.plans pl
    -- What the package the twin was copied from would be charged today, so that 'mirrored'
    -- means "this is still somebody else's figure" rather than "this row was copied".
    left join lateral (select public.sl_plan_ghp(pl.mirror_of) as price_ghp) m on true
    cross join lateral (select public.sl_plan_ghp(pl.id) as price_ghp) x
    where pl.active
      -- Anything that is not named 'intl' means the home shelf, so a blank or a stale argument
      -- from an older app still gets the customer the packages he has always been shown, and an
      -- older app — which asks this question with no shelf in it at all — can never be handed an
      -- abroad row beside the home one it already lists.
      and case when p_market = 'intl' then (
             pl.market = 'intl'
             or (pl.market is distinct from 'intl'
                 and not exists (
                   select 1 from public.plans t
                   where t.market = 'intl' and t.active
                     and (t.mirror_of = pl.id or t.id = pl.id || '-intl')
                 ))
           ) else (
             pl.market is distinct from 'intl'
           ) end
  )
  select jsonb_build_object(
    'ok', true,
    'enabled', coalesce((select ac.paystack_enabled from public.app_config ac where ac.id = 1), false),
    'market', case when p_market = 'intl' then 'intl' when p_market = 'both' then 'both' else 'gh' end,
    -- What the buyer is SHOWN, and it is different per shelf because his customers are: the
    -- abroad list prints the dollar figure the seller typed into price_cents, the home list
    -- prints the cedi figure. This changes no money. The amount taken stays the cedi figure on
    -- both shelves, because payments.currency allows nothing but GHS and Paystack refuses USD
    -- for this merchant account ("Currency not supported by merchant", proven against the live
    -- API on 2026-10-17) — so a buyer abroad reads dollars here and Paystack charges him the
    -- cedi equivalent on its own screen.
    'price_shows', case when p_market = 'intl' then 'USD' else 'GHS' end,
    'currency', 'GHS',
    'ghs_per_usd', coalesce((select ac.paystack_ghs_per_usd from public.app_config ac where ac.id = 1), 12),
    -- Two doors are only ever open together for a till that does not know shelves yet — a page
    -- somebody has bookmarked, or an app build that has not updated. It gets exactly what it
    -- got before this split, which is the seller's own switch list, and can still take money.
    -- A request that does name a shelf gets that shelf's one door, and the seller's switch can
    -- only ever CLOSE it, never open a door on the wrong shelf: turning mobile money off leaves
    -- the home till with no way to pay, which is exactly what he asked for, and it cannot put a
    -- card form in front of a customer in Accra. An empty list here is answered by the checkout
    -- function, and an order is refused rather than quietly given the other method.
    'channels', case
      when p_market = 'both' then
        coalesce((select ac.paystack_channels from public.app_config ac where ac.id = 1),
                 array['card', 'mobile_money'])
      when p_market = 'intl' then
        case when coalesce((select 'card' = any (ac.paystack_channels)
                              from public.app_config ac where ac.id = 1), true)
             then array['card']::text[] else '{}'::text[] end
      else
        case when coalesce((select 'mobile_money' = any (ac.paystack_channels)
                              from public.app_config ac where ac.id = 1), true)
             then array['mobile_money']::text[] else '{}'::text[] end
    end,
    'packages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.shown_name, 'blurb', s.shown_blurb, 'includes', s.includes,
        'features', s.features,
        'market', s.market,
        -- True when the figure on this abroad card is not an abroad price yet: either the
        -- seller's own twin row still costing exactly what the row it was copied from costs, or
        -- no twin at all, so the home row itself is standing on the foreign shelf.
        'mirrored', s.falls_back
          or (s.market = 'intl' and s.mirror_of is not null
              and coalesce(s.price_ghp, -1) = coalesce(s.original_price_ghp, -1)),
        'price_cents', coalesce(s.price_cents, 0),
        'price_ghp', case when s.buyable then s.price_ghp end,
        'listed_price_ghp', s.price_ghp,
        'video_minutes', coalesce(s.video_minutes, 0),
        'audio_minutes', coalesce(s.audio_minutes, 0),
        'video_audio_minutes', coalesce(s.video_audio_minutes, 0),
        'max_devices', s.max_devices,
        'buyable', s.buyable
      ) order by s.buyable desc nulls last, s.price_ghp nulls last, s.name)
      from shelf s
    ), '[]'::jsonb)
  );
$$;

comment on function public.sl_paystack_packages(text, text) is
  'the shelf the buyer sees, for one market and in his own language: every active package on that shelf, each with its cedi price (null when none is set), its own market, a buyable flag, and whether its figure is still the Ghana one. A named shelf has one door — mobile money at home, card abroad — and the seller''s panel switch can only close it, never swap it. p_market = ''both'' is the pre-split answer for a till that has no shelf on its address: the whole home list and the seller''s own channel switches, so a bookmarked page or an un-updated app can still take money. price_shows says which currency a card is printed in — USD abroad, GHS at home — and changes nothing about the amount charged, which is cedis on both shelves.';

-- Same hygiene as every other payment function: the till is a page with no login, so it must
-- not be able to read the catalogue straight out of the database. Only this repository's own
-- checkout function asks, and it asks with the service key.
revoke execute on function public.sl_paystack_packages(text, text) from public;
revoke execute on function public.sl_paystack_packages(text, text) from anon;
revoke execute on function public.sl_paystack_packages(text, text) from authenticated;
grant execute on function public.sl_paystack_packages(text, text) to service_role;

-- ─── the hosted Paystack page, with two shelves underneath it ───────────────────────────
-- Route B: a payment page built inside Paystack's own dashboard, where this gateway sees
-- nothing until the money lands and the AMOUNT is what says which package was bought. Now that
-- every Ghana package has an international twin at the same figure, one amount matches two
-- rows, and the existing answer to that is 'ambiguous_price' — money taken, minutes refused.
-- So a copied twin stands out of the matching: the page is a cedi page with no shelf on it,
-- and the row it can honestly name is the one the seller priced. A package he makes
-- international on purpose carries no mirror_of and keeps its own place in the matching.
-- Everything else about this function is unchanged from 20261017160000.
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
    where pl.active and pl.mirror_of is null and public.sl_plan_ghp(pl.id) = v_amount;
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
    where pl.active and pl.mirror_of is null and public.sl_plan_ghp(pl.id) = v_amount limit 1;

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

comment on function public.sl_paystack_page_credit(text, jsonb) is
  'route B: a payment made on Paystack''s own hosted page, where the amount says which package and the payer''s email says whose account it is. Copied international twins (plans.mirror_of) stand out of the amount matching, because the shelf a buyer meant is not on that page and every twin shares its original''s figure.';

revoke execute on function public.sl_paystack_page_credit(text, jsonb) from public, anon, authenticated;
grant  execute on function public.sl_paystack_page_credit(text, jsonb) to service_role;
