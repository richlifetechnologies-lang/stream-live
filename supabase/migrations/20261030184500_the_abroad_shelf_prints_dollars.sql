-- ─── why this file exists at all ────────────────────────────────────────────────────────
-- 20261030120000_two_shelves_ghana_and_international.sql was applied to this database at
-- 17:16 on 2026-10-30, in the form it had at that moment. Two things were settled after that
-- window closed, and neither can reach the server by editing that file: Postgres records a
-- migration by its version number and never runs the same version twice, so the corrected
-- shelf read below is the only way to land it.
--
--   1. A buyer outside Ghana is shown the dollar figure the seller typed, not the cedi
--      figure. This is the display only. The amount taken is still cedis, because
--      payments.currency allows nothing else and Paystack refuses USD on this merchant
--      account ("Currency not supported by merchant", proven against the live API on
--      2026-10-17). Until this runs, the hosted till answers a foreign buyer's request with
--      no price_shows in it, and the till falls back to printing GH₵ abroad — the bug.
--   2. A till address that names no shelf at all — a bookmarked page, or an app build that
--      has not updated — is answered as 'both': the home list and the seller's own channel
--      switches, exactly what it got before the split, so it can still take money.
--
-- NOTHING HERE TOUCHES THE CATALOGUE. The five packages on the abroad list and the prices on
-- them are left exactly as they stand; this file replaces one function's body and re-asserts
-- who may call it. No package is created, renamed, repriced, deactivated or deleted.

-- ─── the shelf, read for one market ─────────────────────────────────────────────────────
-- The no-argument form stays dropped: with both arguments defaulted, a call that names none
-- would match two functions and Postgres would refuse it as ambiguous — and every installed
-- app that has not updated yet asks exactly that question. With the defaults it answers the
-- same as before: the Ghana shelf, cedis, mobile money.
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
