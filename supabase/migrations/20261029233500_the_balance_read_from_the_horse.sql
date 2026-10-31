-- ─────────────────────────────────────────────────────────────────────────────
-- The fal.ai balance the admin panel reads, and the key it reads it with.
--
-- Why a table at all: the panel shows the money side of every call, but the key
-- that QUERIES a balance is not the key that SPENDS it. A fal key with the BILLING
-- preset can read the account balance and the usage figures and cannot open an
-- inference call, while an API-preset key does the opposite. Putting a billing key
-- in gateway_keys would let sl_pick_keys hand it to a live call, which would fail
-- that call. So it lives on its own, and nothing in the pick path looks at it.
--
-- Why one row: fal reports the balance for the whole account, not per key, so a
-- second billing key would show the identical number twice and the card would have
-- to pick one to display. If the account is ever split, that is a new design, not a
-- new row.
--
-- SECURITY: row level security is enabled with NO policies. A browser holding the
-- publishable anon key therefore reads nothing from this table, not even the tail of
-- the key — the only way in is the admin-api Edge Function, which connects with the
-- service role after requireAdmin(). The secret column is never selected into a
-- response; the panel is told whether a key is stored and shown its last four
-- characters, the same way the key pool table already behaves.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.fal_watch (
  id          uuid primary key default gen_random_uuid(),
  label       text    not null default 'fal balance key',
  billing_key text    not null,
  -- The card goes amber under warn_below and red under alert_below. Both are null
  -- until the administrator types them, and a null threshold means no colour, not
  -- no reading — the balance itself always comes from fal.
  warn_below  numeric(10,2),
  alert_below numeric(10,2),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists one_fal_watch_row
  on public.fal_watch ((true));

alter table public.fal_watch enable row level security;

comment on table public.fal_watch is
  'one row: the read-only fal.ai billing key the admin panel asks for the account balance, plus the amounts that turn the card amber or red; service role only, no client policy';
