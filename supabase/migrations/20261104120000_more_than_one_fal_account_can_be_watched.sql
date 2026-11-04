-- ─────────────────────────────────────────────────────────────────────────────
-- More than one fal.ai account can be watched at once.
--
-- The card that reads a balance was built around one stored billing key, because fal
-- reports the balance for a whole account and a second key on the SAME account would
-- only show the identical number twice. That reasoning held until a second account
-- appeared: the table allowed one row by a unique index on a constant, so pasting
-- another account's billing key did not add it — it overwrote the first one, and the
-- card silently started reporting a different account's money as though it had always
-- been the only one.
--
-- This drops that index. The row already stored is untouched and becomes the first
-- account in the list; nothing about the keys that SPEND money changes, because
-- gateway_keys is a different table and the pick path never looks at this one.
--
-- SECURITY is unchanged: RLS stays on with no policies, so a browser holding the
-- publishable anon key still reads nothing here. Only admin-api, running with the
-- service role behind requireAdmin, touches these rows, and it never selects the
-- secret into a response — the panel is told a tail, the same as before.
--
-- One guard is added in place of the index that went away: the same billing key
-- cannot be stored twice. Two rows reading the same account would double its balance
-- in the total, which is the exact error this card exists to avoid.
-- ─────────────────────────────────────────────────────────────────────────────

drop index if exists public.one_fal_watch_row;

create unique index if not exists fal_watch_one_row_per_key
  on public.fal_watch (billing_key);

comment on table public.fal_watch is
  'one row per fal.ai account: a read-only BILLING-preset key, the name shown on the card, and the amounts that turn that account amber or red; service role only, no client policy';
