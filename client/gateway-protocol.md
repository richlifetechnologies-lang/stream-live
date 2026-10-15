# Gateway protocol

What a client may call, in the order a call uses them. `client/stream-live-client.ts`
implements all of this; use it instead of hand-rolling requests.

Every request is `POST https://<ref>.supabase.co/functions/v1/<name>` with
`Authorization: Bearer <user JWT>` (Supabase auth session). A missing or expired JWT
is a 401 — sign in first. Errors come back as
`{ error, reason, ... }` with a status that matches the reason:

| reason | HTTP | Client action |
| --- | --- | --- |
| `out_of_minutes` | 402 | stop, tell the user to request credits |
| `modality_disabled`, `device_limit`, `device_revoked`, `status_*`, `no_subscription` | 403 | stop, show the account panel |
| `update_required` | 412 | force the updater |
| `concurrent_limit` | 409 | refuse a third simultaneous call |
| `maintenance` | 503 | show the maintenance message |
| `upstream_key` | 502 | a gateway key failed; the prepaid chunk was refunded already |

`REASON_MESSAGES` in the SDK maps each of these to user-facing text.

## 1. Sign in

```ts
const client = new StreamLiveClient({ supabaseUrl, supabaseAnonKey, falAppId: "lucy-2-5", appVersion });
await client.signUp(email, password, displayName, deviceId); // see §1.1
await client.signIn(email, password);
await client.restoreSession();
```

Sign-up is open, verification is off, and the account is usable the moment it is
created — with an empty wallet.

### 1.1 Sign-up metadata

`deviceId` is the same stable install id `startCall()` sends. It rides along at
account creation because the free trial is granted per **computer**, not per account:
the gateway records the machine in its own trial register and refuses a second grant to
a device that has already carried one. A sign-up that carries no device id (a build
older than this change) keeps the previous one-trial-per-account behaviour, so the
funnel stays open while installs update themselves — nothing about the outcome is
decided in the app, and the client promises nothing.

Addresses are checked against the same shape on the server, so an older build cannot
create an account with an email that cannot exist.

Sign-up is open and the account is usable the moment it is created — with an empty
wallet unless the trial was granted.

## 2. Open a lease — `start-session`

```ts
const ticket = await client.startCall(tab, deviceId);
// { sessionId, token, modality, leaseExpiresAt, expiresInSeconds,
//   unlimited, balance, leaseMinutes, wallet }
```

Request body: `{ appId, deviceId, tab, appVersion }`, where `tab` is
`video-only | audio-only | video-audio`; the modality is derived from it.

The gateway has already debited one chunk of minutes by the time this returns, and
`token` is a fal JWT that expires with the lease. **`token` is `null` on the Audio
Call tab** — voice-only calls must never open a video session. Pass the token into
the WebRTC handshake exactly as a locally minted one would be used; it is only
needed at handshake time, not per frame.

`deviceId` must be stable per install. In Electron, use the OS machine id
(`desktop/electron/main.ts` exposes it over IPC as `getDeviceId()`); `deviceIdFrom()`
hashes any other seed.

## 3. Keep it alive — `lease`

```ts
client.beginHeartbeat(state => {
  if (state.ended) stopTheCall();          // bucket cannot fund another chunk
}, 45_000);
```

Body `{ sessionId, action: "renew" }` →
`{ ended, reason, balance, unlimited, leaseExpiresAt, billedMinutes, lowBalance }`.

Each renew settles the elapsed window (real minutes × burn rate), refunds the unused
part of the pre-paid chunk and pre-pays the next one. The heartbeat interval must be
comfortably below the lease TTL (default 120 s); if a renew does not land, the
session is reaped at `lease_expires_at` and nothing further is billed.

Always end deliberately: `await client.endCall()` (an `action: "end"` lease call) on
stop, on error and on window close. `endCall` retries once and, if the gateway is still
unreachable, remembers the session and hands it back on the next `startCall`, so a lost
Stop cannot leave the machine reading as "already on a call".

## 4. Voice — `proxy-voice`

```ts
const res = await client.voice("/v1/speech-to-speech/<voiceId>/stream", formData, {
  isStream: true,
  sessionId: ticket.sessionId,
});
const audio = res.body; // audio/mpeg, streamed straight from ElevenLabs
```

The SDK accepts a plain object (JSON), a string (`text/plain`) or a `FormData`
(multipart, base64-enclosed in the gateway envelope) — voice cloning and voice
upload both need `FormData`. The ElevenLabs key is attached inside the function and
is never sent to the client.

Allowed paths are checked twice: inference (`/v1/speech-to-speech/…`,
`/v1/text-to-speech/…`) needs a live lease on an audio or video+audio bucket;
library calls (`/v1/voices`, `/v1/voices/add`) need an account whose audio bucket
exists. Anything else is rejected.

## 5. Money is not a client API

Balances, ledger, credit requests and devices are RLS-scoped reads:
`client.wallets()`, `client.ledger()`, `client.requestTopup({ modality, minutes,
paymentChannel, paymentReference, note })`, `client.devices()`. A device row is
read-only to the account that owns it — only an administrator can revoke or delete a
binding, from the panel. There is deliberately no client method for it: a user who
removed their own device could never bind it again, and only an admin could undo that.

Crediting an account is **never** reachable from a client token —
`sl_grant_credits`, `sl_resolve_request`, `sl_pick_keys` and the rest are
`service_role` only. The admin panel calls `admin-api`, which verifies
`profiles.is_admin` before doing any of it:

```ts
await client.admin("grant",  { userId, modality, minutes, reason });   // reason required
await client.admin("resolve",{ requestId, approve: true, minutes, note });
await client.admin("end_session", { sessionId });
await client.admin("reap",   { userId });        // close abandoned leases for one account
await client.admin("signout",{ userId });        // every device, every session
```

## 6. Desktop wiring already in this repo

`desktop/src/lib/gateway.ts` holds the singleton plus a `useAccount()` store;
`desktop/src/App.tsx` gates the stream route behind a session; the account page
(`desktop/src/pages/account.tsx`) is sign-in, balances, credit requests, devices and
sign-out; `desktop/src/pages/stream.tsx` opens the lease before touching WebRTC,
routes voice cloning through `gateway.voice(...)`, runs the heartbeat and ends the
call in every teardown path. Settings has no key fields, and `purgeLegacyKeys()`
deletes the `ss_api_key` / `ss_elevenlabs_key` / `ss_license_key` / `ss_demo_key`
entries (and the old invented session history) that pre-gateway builds left behind.
