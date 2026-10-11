# Deploy runbook — taking STREAM LIVE live

One-time setup for a Supabase project, then the per-release steps. Nothing here
needs a server: Postgres, Edge Functions, auth and hosting of the admin panel are
all Supabase.

## 0. Prerequisites

- A Supabase project. Note the project ref, e.g. `onhanfathvfkkliayvrn`.
- The Supabase CLI (`npm i -g supabase` or a downloaded binary) — logged in with an
  account that owns the project.
- A fal.ai key and an ElevenLabs key. These never enter this repo.

```bash
supabase login
supabase link --project-ref onhanfathvfkkliayvrn
```

`supabase/config.toml` already sets `verify_jwt = false` for every function: each
function checks the caller's JWT itself, because Edge-Function-level verification
rejects the anonymous-key requests the admin panel makes before signing in.

## 1. Schema

```bash
supabase db push
```

If the CLI cannot reach the database (IP block, no password), open the dashboard
**SQL Editor** and run the files in `supabase/migrations/` in name order. The
latest one, `20261011000000_stream_live_credits.sql`, is the whole money model:
three non-expiring buckets, append-only ledger, leases, top-up queue, burn rates,
key pool, `app_config`, and the role grants. It is safe to re-run.

Do not skip the `revoke ... from public, anon, authenticated` block at the end of
that file. Supabase grants newly created public functions to `anon` and
`authenticated` by default, which would let any signed-in user call
`sl_grant_credits` and credit themselves.

## 2. Secrets

Dashboard → **Configuration → Environment variables** (or `supabase secrets set`),
for the Edge Functions:

| Secret | Used by | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | all | your project URL |
| `SUPABASE_ANON_KEY` | all | public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | all | bypasses RLS — functions only, never shipped |
| `FAL_KEY` | start-session | last-resort key; the admin pool is preferred |
| `ELEVENLABS_KEY` | proxy-voice | last-resort key; the admin pool is preferred |

`_shared/keys.ts` resolves keys in this order: the account's
`user_key_assignments` row, then enabled `gateway_keys` rows by priority (skipping
any that hit their daily cap or failed health checks), then the environment secret.
Every attempt is recorded in `key_usage_log`.

## 3. Functions

```bash
supabase functions deploy start-session
supabase functions deploy lease
supabase functions deploy proxy-voice
supabase functions deploy admin-api
supabase functions deploy admin
```

`admin` serves the panel HTML from `supabase/functions/admin/html.ts`. If you edit
`index.html`, regenerate first:

```bash
node scripts/gen-admin-html.mjs
```

**Delete the two retired functions** — they read the old `minutes_used` column and
would let a stale client bypass the lease model:

```bash
supabase functions delete mint-fal-token
supabase functions delete usage-heartbeat
```

## 4. Auth settings

Dashboard → **Authentication → Sign In / Up**:

- **Confirm email: OFF** — users must be able to sign in the moment they register.
- Password length ≥ 8, HIBP optional.
- **Site URL** = your project URL (only matters if you add OAuth later).
- Rate limits: leave the defaults on `Do not allow new signups when you hit the
  limit` until you have watched the sign-up volume.

`app_config.signup_enabled = false` is a second, admin-controlled switch
(`sl_guard_signup` raises on insert into `auth.users`) — use it to stop new
registrations without touching Supabase settings.

## 5. First administrator

Sign up from the panel's login page (or any client) with the address that will run
the show, then:

```sql
update public.profiles set is_admin = true where email = 'you@example.com';
```

Open the panel at `https://<ref>.supabase.co/functions/v1/admin`. Enter the project
URL and the anon key once; they are kept in that browser's localStorage. Every write
still goes through `admin-api`, which re-checks `is_admin` server-side.

## 6. Keys and credits

1. **Key pool tab** — add the fal.ai key (provider `fal`) and the ElevenLabs key
   (`elevenlabs`). Set `priority` (lower wins), an optional `daily_minute_cap`, and
   tick the ones you want as default. Optionally pin one key to one account with a
   `user_key_assignments` row.
2. **Accounts tab** — find the account, press **Grant minutes**, pick the modality
   bucket, the amount and a reason (mandatory — it is written to the ledger).
   Deduct is the same form with a negative amount.
3. **Gateway tab** — set `latest_version` and `min_supported_version` to the build
   you are about to ship (see step 8).

## 7. Smoke test (spends real money — keep it tiny)

Grant a **test** account 3 minutes, then:

- Sign in on the desktop app and start an **Audio Call** for ~30 s. Watch
  **Live sessions**: a lease appears, its `pending_debit` moves, and after you stop
  the ledger shows a `debit` for what was used and a `release` for the refund.
- Confirm the bucket balance fell by the burned amount and no more.
- Start a second call on another device until `max_concurrent_sessions` is reached —
  the gateway must refuse with `concurrent_limit`.
- Drain the bucket, start a call, and confirm the app stops cleanly with the
  out-of-credits message rather than leaving a session open.
- **Video Call** must be tested once per release with a reference image, since the
  fal JWT now comes from the gateway. Keep the call short.
- Kill switch: set `min_supported_version` above the installed version and confirm
  `start-session` answers `412 update_required` and the app shows the updater.

## 8. Desktop release

From `desktop/`:

```bash
VITE_SUPABASE_URL=https://<ref>.supabase.co \
VITE_SUPABASE_ANON_KEY=<anon key> \
npm run build && npx electron-builder --win --x64
```

The anon key is a public client credential, but the build must carry it — without it
the app refuses to sign in and says the gateway is not configured.

Publish to `richlifetechnologies-lang/stream-live` as tag `v<version>` with three
assets: `StreamLive-Setup-<version>.exe`, its `.blockmap` and `latest.yml`. The
in-app updater lists releases from that repo and matches
`StreamLive-Setup-*.exe`, so **verify the uploaded exe's sha256 equals the local
file** before telling anyone the release is out — a truncated upload is the failure
mode that looks like a broken installer.

Then raise `app_config.latest_version` (and `min_supported_version` when an old
build must be forced off).

## 9. Rollback

- Money model: `delete from public.credit_balances ...` is never the answer — post
  an `adjust` row from the panel, the ledger stays truthful.
- Functions are stateless: redeploy the previous commit's function.
- A bad migration: the credits migration is additive except for
  `subscriptions.status` default; restore with
  `alter table public.subscriptions alter column status set default 'trialing'`.
- Emergency stop for all calls: `update public.app_config set maintenance = true,
  maintenance_message = '...';` — `start-session` answers 503 while it is set.
