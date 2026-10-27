// POST start-session
// The only way the desktop app can begin a call. It proves the account, binds the
// device, opens an atomic metered lease (pre-paid chunk of wallet minutes) and —
// for the modalities that need video — mints a short-lived fal.ai JWT from a key in
// the admin pool. No master key is ever returned to the client.
//
// Body: { appId: string, deviceId?: string, tab: string, appVersion?: string }
// Resp: { sessionId, token|null, expiresInSeconds, leaseExpiresAt, modality,
//         balance, unlimited, wallet, leaseMinutes }
// Errors: 401 auth, 402 no balance, 403 entitlement/device, 409 concurrent limit,
//         412 update required, 429 the line is still being released (with
//         retry_after_seconds), 503 maintenance, 502 upstream key failure.
import { preflight, json, fail } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { adminClient } from "../_shared/db.ts";
import { modalityForTab, readAccount, startLease, updateLease } from "../_shared/credits.ts";
import { checkAndBindDevice, compareVersions, planMaxDevices } from "../_shared/devices.ts";
import { runWithKeys } from "../_shared/keys.ts";

/** Fallback when app_config has no lease TTL yet; the JWT must outlive one heartbeat. */
const DEFAULT_TOKEN_TTL_SECONDS = 120;

/**
 * A customer stands at a spinner while these two handshakes are in flight, so a vendor
 * that goes quiet instead of refusing has to be given up on. 15 seconds, the same figure
 * the payment calls already hold.
 */
const UPSTREAM_TIMEOUT_MS = 15_000;

/** Reasons that mean "ask the administrator for minutes", not "you did something wrong". */
const STATUS_BY_REASON: Record<string, number> = {
  out_of_minutes: 402,
  no_subscription: 403,
  modality_disabled: 403,
  device_revoked: 403,
  device_limit_reached: 403,
  status_canceled: 403,
  status_past_due: 403,
  status_expired: 403,
  concurrent_limit: 409,
  lines_busy: 429,
  maintenance: 503,
};

// The video app this product sells, in the spelling fal.ai documents for an app id:
// owner/name, plus the endpoint suffix. The desktop opens
// wss://fal.run/decart/lucy-2-5/realtime, so that is the app a call has to be allowed for.
const REALTIME_APP = "decart/lucy-2-5/realtime";

async function mintFalToken(userId: string, appId: string, ttlSeconds: number) {
  const expiration = Math.max(DEFAULT_TOKEN_TTL_SECONDS, ttlSeconds);
  // Builds up to 1.8.6 ask for the bare "lucy-2-5", which is not an app id fal's own
  // documentation recognises, and a mint for it still comes back 200. Both spellings are
  // carried so a token is good for whatever the installed build opens.
  //
  // This is naming hygiene, not the cure for the calls that die a few seconds in. The
  // live records say the refusals follow the customer's machine and its re-ask spacing,
  // and calls on that same bare-name token did get through while others did not - so
  // fixing this alone would leave the complaint exactly where it is. The gate that
  // answers it is the machine pacing added to sl_start_session.
  const allowedApps = Array.from(new Set([appId, REALTIME_APP].filter(Boolean)));
  return runWithKeys<{ token: string; expiresAt: string }>(userId, "fal", async (key) => {
    const res = await fetch("https://rest.fal.ai/tokens/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Key ${key.secret}` },
      body: JSON.stringify({ allowed_apps: allowedApps, token_expiration: expiration }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, detail: `fal token error (${res.status}) ${(await res.text().catch(() => "")).slice(0, 200)}` };
    }
    const raw = await res.text();
    let token = raw.trim();
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") token = parsed;
      else if (parsed?.detail) token = String(parsed.detail);
      else if (parsed?.token) token = String(parsed.token);
      else token = raw.replace(/^"|"$/g, "");
    } catch { /* plain-text token */ }
    // Nothing is booked against the key here. The prepaid chunk is only a hold: the
    // call may never deliver a frame and get refunded, and every minute after the
    // first window was always billed by the lease, not by this mint. sl_settle_window
    // books each window against usage_sessions.fal_key_id, so a key's daily figure is
    // the minutes it actually delivered.
    return {
      ok: true,
      value: { token, expiresAt: new Date(Date.now() + expiration * 1000).toISOString() },
      minutes: 0,
    };
  });
}

/**
 * A short-lived Decart client token for one trial session.
 *
 * The vendor's rule is "never expose your permanent API key in client-side code",
 * so the master key stays here and the client gets a throwaway. It is one plain
 * POST, not the npm SDK: the SDK's realtime half drags a whole WebRTC stack in, and
 * the only thing the server needs from it is this endpoint. The token is scoped to
 * lucy-2.5 so a leaked throwaway cannot run anything else on the account, and the
 * TTL covers the lease window plus room to reconnect, capped at the vendor's 3600.
 */
async function mintDecartToken(userId: string, ttlSeconds: number, billMinutes: number) {
  const expiresIn = Math.min(3600, Math.max(DEFAULT_TOKEN_TTL_SECONDS, ttlSeconds + 180));
  return runWithKeys<{ token: string; expiresAt: string | null }>(userId, "decart", async (key) => {
    let res: Response;
    try {
      res = await fetch("https://api.decart.ai/v1/client/tokens", {
        method: "POST",
        headers: { "X-API-KEY": key.secret, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn, allowedModels: ["lucy-2.5"] }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, detail: `decart unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      return { ok: false, status: res.status, detail: `decart answered ${res.status}: ${body.slice(0, 200)}` };
    }
    let parsed: { apiKey?: unknown; expiresAt?: unknown };
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, status: res.status, detail: "decart answered with unreadable JSON" };
    }
    const token = String(parsed?.apiKey ?? "");
    if (!token) return { ok: false, status: res.status, detail: "decart returned a token response with no api key" };
    return {
      ok: true,
      value: { token, expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null },
      minutes: billMinutes,
    };
  });
}

/**
 * The caller's address as the platform saw it. A forwarded-for header can carry a chain
 * somebody typed, so only the first entry is taken and only when it is shaped like a
 * bare IPv4 or IPv6 address; anything else is treated as no address at all.
 */
function requestIp(req: Request): string {
  const raw = req.headers.get("x-forwarded-for")
    || req.headers.get("x-real-ip")
    || req.headers.get("cf-connecting-ip")
    || "";
  const first = raw.split(",")[0].trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(first) ? first : "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return fail("method not allowed", 405);

  try {
    const user = await requireUser(req);
    // Recorded ahead of every gate below: a call that is about to be refused is precisely
    // the one that has to be diagnosable afterwards, and the address is the only thing that
    // separates "two accounts, one computer" from "two computers that share a name".
    const ip = requestIp(req);
    if (ip) {
      try {
        await adminClient().rpc("sl_note_network", { p_user: user.id, p_ip: ip });
      } catch {
        // Bookkeeping never gets to refuse a call.
      }
    }
    const body = await req.json().catch(() => ({}));

    const appId = typeof body.appId === "string" ? body.appId.trim() : "";
    const tab = typeof body.tab === "string" ? body.tab : "video-audio";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : undefined;
    const appVersion = typeof body.appVersion === "string" ? body.appVersion.trim() : undefined;
    if (!appId) return fail("appId is required");

    const modality = modalityForTab(tab);
    const acct = await readAccount(user.id, modality);

    if (appVersion && acct.minSupportedVersion && compareVersions(appVersion, acct.minSupportedVersion) < 0) {
      return fail(`Stream Live ${appVersion} is no longer supported`, 412, {
        reason: "update_required",
        min_supported_version: acct.minSupportedVersion,
        latest_version: acct.latestVersion ?? null,
      });
    }

    if (!acct.ok) {
      return fail(String(acct.reason ?? "denied"), STATUS_BY_REASON[acct.reason ?? ""] ?? 403, {
        reason: acct.reason,
        message: acct.reason === "maintenance" ? acct.maintenanceMessage : undefined,
        balances: acct.balances,
      });
    }

    const maxDevices = await planMaxDevices(acct.planId);
    const dev = await checkAndBindDevice(user.id, deviceId, maxDevices);
    if (!dev.allowed) {
      return fail(String(dev.reason), 403, { reason: dev.reason });
    }

    const started = await startLease(user.id, modality, tab, deviceId);
    if (!started.lease) {
      // A paced machine is told how long to wait, in seconds, so the app can count it
      // down instead of pressing a dead pass. Only a number ever leaves; the gate's own
      // wording stays in the record.
      const wait = Number((started.detail as { retry_after_seconds?: unknown } | null)?.retry_after_seconds);
      return fail(String(started.reason ?? "could not start session"),
        STATUS_BY_REASON[String(started.reason ?? "")] ?? 403,
        {
          reason: started.reason,
          balances: acct.balances,
          retry_after_seconds: Number.isFinite(wait) && wait > 0 ? Math.min(Math.round(wait), 600) : null,
        });
    }
    const lease = started.lease;

    // Audio Call is voice-only: no video key, nothing else to mint.
    let token: string | null = null;
    let expiresAt: string | null = null;
    const engine = lease.engine;
    if (modality !== "audio") {
      const minted = engine === "decart"
        ? await mintDecartToken(user.id, lease.ttlSeconds, lease.chunkMinutes)
        : await mintFalToken(user.id, appId, lease.ttlSeconds);
      if (!minted.ok) {
        // Give the prepaid chunk straight back — the call never happened.
        await updateLease(lease.sessionId, "end").catch(() => null);
        // The upstream's own wording (and any key detail inside it) is recorded in
        // key_usage_log; the user gets the reason, not the raw upstream body. A
        // Decart failure is refunded and refused here: it never re-tries on fal,
        // because trial traffic must not spend the paid balance.
        return fail("our video service is not answering right now", 502, { reason: "upstream_key" });
      }
      token = minted.value?.token ?? null;
      expiresAt = minted.value?.expiresAt ?? null;
      if (engine === "decart" && minted.keyId) {
        const db = adminClient();
        await db.rpc("sl_book_decart_minutes", {
          p_key_id: minted.keyId,
          p_minutes: lease.chunkMinutes,
          p_session_id: lease.sessionId,
        });
      }
      // The paid-video key that served this call has to be remembered on the session,
      // because the minutes that make the call expensive are booked later, window by
      // window, inside the lease settle. 'env' is the last-resort secret rather than a
      // pooled key, so there is no row to attribute it to.
      if (engine !== "decart" && minted.keyId && minted.keyId !== "env") {
        const db = adminClient();
        const { error } = await db
          .from("usage_sessions")
          .update({ fal_key_id: minted.keyId })
          .eq("id", lease.sessionId);
        if (error) console.error(`[start-session] fal key link failed: ${error.message}`);
      }
    }

    return json({
      sessionId: lease.sessionId,
      token,
      tokenExpiresAt: expiresAt,
      engine,
      expiresInSeconds: lease.ttlSeconds,
      leaseExpiresAt: lease.leaseExpiresAt,
      modality,
      tab,
      unlimited: lease.unlimited,
      balance: lease.balance,
      leaseMinutes: lease.chunkMinutes,
      wallet: acct.balances ?? {},
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unauthorized";
    const status = /authoriz|session|token/i.test(msg) ? 401 : 500;
    return fail(msg, status);
  }
});
