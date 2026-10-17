-- 2026-10-17: the buy page must show every package the seller lists.
--
-- The first version of the shelf kept only the packages that were ready to sell:
-- switched on, carrying minutes, and carrying a price. That left the buyer looking at a
-- shorter list than the seller's own Plans screen, with no way to tell a customer which
-- packages exist and which simply are not finished yet.
--
-- Now every switched-on package is listed, and each one carries a `buyable` flag saying
-- whether the payment page will actually take money for it: a package needs both a cedi
-- price and at least one minute attached. The page shows the reason on the card, the
-- checkout function re-checks the flag before it opens an order, and a package that is
-- switched off stays off the list entirely.
--
-- `price_ghp` - the figure an app puts a Buy button on - is deliberately NULL for a package
-- the till will not sell, and the figure a buyer is merely allowed to READ travels in
-- `listed_price_ghp`. An app built before this flag existed decides whether to show a
-- button from price_ghp alone, so no version, old or new, can offer a purchase that the
-- payment page would then refuse.

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
        'price_ghp', case when x.buyable then x.price_ghp end,
        'listed_price_ghp', x.price_ghp,
        'video_minutes', coalesce(pl.video_minutes, 0),
        'audio_minutes', coalesce(pl.audio_minutes, 0),
        'video_audio_minutes', coalesce(pl.video_audio_minutes, 0),
        'max_devices', pl.max_devices,
        'buyable', x.buyable
      ) order by x.buyable desc nulls last, x.price_ghp nulls last, pl.name)
      from public.plans pl
      cross join lateral (
        select price_ghp,
               price_ghp is not null
                 and coalesce(pl.video_minutes, 0) + coalesce(pl.audio_minutes, 0)
                     + coalesce(pl.video_audio_minutes, 0) > 0 as buyable
        from (values (public.sl_plan_ghp(pl.id))) p(price_ghp)
      ) x
      where pl.active
    ), '[]'::jsonb)
  );
$$;

comment on function public.sl_paystack_packages() is
  'the shelf the buyer sees: every active package, each with its cedi price (null when none is set) and a buyable flag; the checkout page lists all of them and only lets money be taken for the buyable ones.';
