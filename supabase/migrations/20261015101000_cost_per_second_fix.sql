-- -- The stored per-second video cost was twice the price the endpoint bills ---
-- billing_config.lucy_video_per_sec_cost was seeded at 0.04000 ($2.40/min) from the
-- wording on fal's Lucy 2.5 FAQ. The billing metadata attached to the exact endpoint
-- this product calls, decart/lucy-2-5/realtime, prices it at 0.02 USD per second
-- ($1.20/min). Only the admin panel's Price Generator reads this table, so nothing a
-- customer is charged or deducted was ever wrong - the cost and margin estimates the
-- panel shows were simply twice as pessimistic as the real spend, which is how a
-- healthy account can look like it only buys 12 minutes of airtime when it buys 25.
--
-- Cost side only. burn_rates, timer_config and every deduction path are untouched.

update public.billing_config
   set lucy_video_per_sec_cost = 0.02000,
       last_verified_at        = '2026-10-15',
       source_notes            = 'Verified from the fal billing metadata for decart/lucy-2-5/realtime: billing_unit seconds, price 0.02 ($1.20/min). fal documentation elsewhere still quotes 0.04/sec for Lucy 2.5, so re-check against the fal billing history after the first paid calls.',
       updated_at              = now()
 where id = 1;

-- The seed default so a rebuilt row cannot reintroduce the old figure.
alter table public.billing_config
  alter column lucy_video_per_sec_cost set default 0.02000;
