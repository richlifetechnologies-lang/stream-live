# STREAM LIVE

Stream Live, production-ready: the desktop app **plus** the account gateway it
runs on. Users create an account and sign in; an administrator grants **minutes**
per modality; every AI key stays on the server. A user never enters an API key.

Everything lives in this one repo:

```
desktop/           Electron app (Stream Live) — version 1.0.0
  electron/          main process: updater, virtual camera, local API server, device id
  src/pages/         stream console, account panel, usage, settings, OBS output windows
  src/lib/gateway.ts singleton client + React store for the signed-in account
client/            the gateway SDK the app imports (stream-live-client.ts) + protocol doc
supabase/          the gateway itself
  migrations/        schema: wallets, ledger, leases, key pool, top-ups, config
  functions/         start-session · lease · proxy-voice · admin-api · admin
scripts/           gen-admin-html.mjs (bundles the panel HTML into html.ts)
```

## The product rules this implements

| Rule | Where it is enforced |
| --- | --- |
| No API keys on the user's machine | `start-session` mints a ≤120 s fal JWT; `proxy-voice` forwards to ElevenLabs. Master keys are gateway secrets or admin-only `gateway_keys` rows. |
| Minutes are granted by an administrator | `sl_grant_credits` / `sl_resolve_request` are `security definer` and **service-role only**; the browser can only reach them through `admin-api`, which checks `profiles.is_admin`. |
| Three independent buckets | `credit_balances(user_id, modality)` — `video`, `audio`, `video_audio`. A call can only spend from its own bucket. |
| Minutes never expire | No date column on a balance; the ledger has no expiry entries. |
| No trials | `subscriptions.status` defaults to `active` and the migration rewrites any `trialing` row. Signup creates no free minutes. |
| Multiple devices per account | `subscriptions.max_concurrent_sessions` (default 2) caps simultaneous leases, not logins. |
| Manual top-up, no payment processing | `credit_requests` queue: the user files a request with a payment reference, the admin approves and credits. No Stripe, no webhooks. |
| Open self-signup, no email verification | Dashboard auth settings (see the runbook). |
| Admin can shut an old build down | `app_config.min_supported_version`; `start-session` answers `412 update_required`. |

## How a call is paid for

Prepaid leases, so a crashed call can never run up a bill:

1. `start-session` → `sl_start_session` locks the bucket row (`FOR UPDATE`), refuses
   if the balance is under a minute or the concurrency cap is reached, then
   **debits one chunk** (`app_config.lease_chunk_minutes`, default 5) and opens a
   session whose `lease_expires_at` is `now() + lease_ttl_seconds` (default 120).
2. The app calls `lease` every 45 s. Each renew **settles the window that just
   elapsed** (real minutes × burn-rate multiplier, billed against the prepaid chunk),
   refunds the unused remainder to the bucket and pre-pays the next chunk.
3. `lease` answers `ended: true` when the bucket cannot fund another chunk — the app
   tears the stream down and tells the user to ask for a top-up.
4. Ending a call (or losing the heartbeat) settles and refunds; a reaper
   (`sl_reap_sessions`) closes abandoned leases lazily so minutes and concurrency
   slots are never stranded.

Every movement is an append-only row in `credit_ledger`; balances are never
rewritten in place.

## Table map

| Table | Purpose |
| --- | --- |
| `credit_balances` | one row per (user, modality): balance, `unlimited`, totals |
| `credit_ledger` | append-only history — credit / debit / release / adjust |
| `credit_requests` | manual top-up queue (pending → approved / rejected) |
| `burn_rates` | versioned per-modality multipliers; a new row never edits history |
| `usage_sessions` | one metered lease per call (`modality`, `pending_debit`, `billed_minutes`) |
| `gateway_keys` | admin key pool: provider, priority, daily caps, health, failover log |
| `user_key_assignments` | pin an account to a specific fal / ElevenLabs key |
| `key_usage_log` | which key served which account and the outcome |
| `devices` | per-install device ids bound to an account |
| `app_config` | kill switch, lease chunk/TTL, signup + maintenance flags |
| `subscriptions` | account status, enabled modalities, `max_concurrent_sessions` |

## Admin panel

`supabase/functions/admin/` serves the panel (HTML bundled into `html.ts` by
`scripts/gen-admin-html.mjs`). Sign in with an account whose `profiles.is_admin` is
true. Tabs: **Accounts** (snapshot, modality toggles, concurrent cap, grant/deduct
with a mandatory reason, devices, sign-out-everywhere, ledger), **Top-ups**
(approve/reject with editable minutes), **Key pool** (CRUD + health + assignments +
24 h usage), **Burn rates** (version, never edit), **Live sessions** (end now, reap),
**Gateway** (`app_config`, minimum-version kill switch, maintenance mode) and
**Plans**. Writes go through `admin-api`, never straight to the database.

After editing `index.html`, regenerate the bundle:

```bash
node scripts/gen-admin-html.mjs
```

## Desktop app

Build (from `desktop/`, Node ≥ 20):

```bash
npm install
npx vite build                       # renderer
npx tsc -p tsconfig.electron.json    # main process
npx electron-builder --win --x64     # installer → release/
```

The gateway URL and anon key are read at build time:

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co \
VITE_SUPABASE_ANON_KEY=<publishable anon key> \
npx vite build
```

Both are public values (the anon key only opens RLS-guarded reads). A build without
them refuses to sign in and says why instead of surfacing a confusing auth error.

Versioning starts at **1.0.0**. Releases are published to
`richlifetechnologies-lang/stream-live` with `StreamLive-Setup-<version>.exe`,
`.blockmap` and `latest.yml`; the in-app updater reads that repo's latest release,
so a build older than `app_config.min_supported_version` shows the update button.

## Deploying / going live

Follow [`DEPLOY.md`](DEPLOY.md) — it covers the migration, the five functions,
deleting the retired ones, secrets, dashboard auth settings, making the first admin
and the smoke test that proves money is actually being metered.

## Security posture

- Money RPCs (`sl_start_session`, `sl_lease`, `sl_grant_credits`, `sl_resolve_request`,
  `sl_pick_keys`, …) are `security definer` and revoked from `anon`/`authenticated`.
  Supabase grants new public functions to those roles by default, so the revoke is
  explicit in the migration — never drop it.
- Views are `security_invoker = true` so RLS keeps applying through them.
- Key material never leaves an Edge Function: `runWithKeys` tries candidates in
  priority order, logs each outcome and returns only the response body.
- The renderer's CSP allow-lists the gateway, the fal relays and the GitHub updater;
  `rest.fal.ai` (the old client-side token endpoint) is gone.
