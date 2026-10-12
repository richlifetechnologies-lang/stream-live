// Master AI keys. A key value never leaves the Edge Function: the caller gets a
// secret only for the duration of one upstream request, and the desktop client
// only ever sees the result (a short-lived fal JWT, or proxied audio).
//
// Selection order, all resolved inside Postgres (sl_pick_keys):
//   1. keys explicitly assigned to this account for this provider
//   2. every other enabled key, cheapest-priority first
//   ...filtered by the per-key daily minute cap and skipped if disabled
//   3. the Edge Function env secret (FAL_KEY / ELEVENLABS_KEY) as last resort
//
// Every attempt is written to key_usage_log, so the admin panel can show which
// keys are failing and when the pool had to fail over.
import { adminClient } from "./db.ts";

export type Provider = "fal" | "elevenlabs";

/**
 * Clean up a pasted key the way the working desktop app does.
 *
 * A fal credential is the pair `<key id>:<secret>`; fal answers 401 "No user found
 * for Key ID and Secret" when either half is missing or the paste was cut short.
 * Pasting from a dashboard that shows `Key fal_sk_…`, or from a field that wraps,
 * leaves a stray prefix or an embedded newline behind — both authenticate as a
 * garbage secret rather than an obvious typo, so strip them here.
 */
export function normalizeSecret(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:key|bearer)\s+/i, "")
    .replace(/\s+/g, "")
    .replace(/:{2,}/g, ":");
}

export type KeyCandidate = {
  keyId: string;
  label: string;
  secret: string;
  priority: number;
  fromEnv: boolean;
};

export type Attempt<T> = {
  ok: boolean;
  value?: T;
  status?: number;
  detail?: string;
  minutes?: number; // wallet minutes burned against this key, for the daily cap
};

export type KeyOutcome<T> = {
  ok: boolean;
  value?: T;
  keyId?: string;
  keyLabel?: string;
  error?: string;
  tried: number;
};

/** Ordered, usable key candidates for one account + provider. */
export async function pickKeys(userId: string, provider: Provider): Promise<KeyCandidate[]> {
  const db = adminClient();
  const { data, error } = await db.rpc("sl_pick_keys", { p_user: userId, p_provider: provider });
  if (error) throw new Error(`sl_pick_keys failed: ${error.message}`);

  const rows: KeyCandidate[] = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    keyId: String(r.key_id),
    label: String(r.label ?? "key"),
    secret: normalizeSecret(String(r.secret ?? "")),
    priority: Number(r.priority ?? 100),
    fromEnv: false,
  }));

  const envSecret = provider === "fal" ? Deno.env.get("FAL_KEY") : Deno.env.get("ELEVENLABS_KEY");
  if (envSecret) {
    rows.push({ keyId: "env", label: "environment secret", secret: normalizeSecret(envSecret), priority: 9999, fromEnv: true });
  }
  return rows.filter((r) => r.secret.length > 0);
}

export async function reportKeyUse(
  keyId: string,
  provider: Provider,
  userId: string,
  outcome: "ok" | "fail",
  minutes = 0,
  status?: number,
  detail?: string,
): Promise<void> {
  const db = adminClient();
  await db.rpc("sl_report_key_use", {
    p_key_id: keyId === "env" ? null : keyId,
    p_provider: provider,
    p_user: userId,
    p_outcome: outcome,
    p_minutes: minutes,
    p_status: status ?? null,
    p_detail: detail ?? null,
  });
}

/**
 * A dead key answers 401/402/429 over and over while the pool burns through every
 * call it could have served. Postgres remembers the failures, so skip a key that
 * has clearly had a bad ten minutes — but never lock the pool out completely.
 */
const COOLDOWN_FAILS = 3;
const COOLDOWN_WINDOW_MS = 10 * 60_000;

async function recentFailures(keyIds: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (keyIds.length === 0) return counts;
  const db = adminClient();
  const { data } = await db
    .from("key_usage_log")
    .select("key_id")
    .in("key_id", keyIds)
    .eq("outcome", "fail")
    .gt("created_at", new Date(Date.now() - COOLDOWN_WINDOW_MS).toISOString());
  for (const row of data ?? []) counts[row.key_id as string] = (counts[row.key_id as string] ?? 0) + 1;
  return counts;
}

/**
 * Try each candidate until one succeeds. `attempt` must not throw for an upstream
 * rejection — return { ok: false, status, detail } so the pool can fail over.
 */
export async function runWithKeys<T>(
  userId: string,
  provider: Provider,
  attempt: (key: KeyCandidate) => Promise<Attempt<T>>,
): Promise<KeyOutcome<T>> {
  const keys = await pickKeys(userId, provider);
  if (keys.length === 0) {
    return {
      ok: false,
      error: `no ${provider} key is available (link one in the admin panel or set ${provider === "fal" ? "FAL_KEY" : "ELEVENLABS_KEY"})`,
      tried: 0,
    };
  }

  const fails = await recentFailures(keys.filter((k) => !k.fromEnv).map((k) => k.keyId));
  const healthy = keys.filter((k) => k.fromEnv || (fails[k.keyId] ?? 0) < COOLDOWN_FAILS);
  // Every key is cooling down: try the quietest one anyway rather than refuse the
  // account outright — a single-key pool must not lock itself out for good.
  const order = healthy.length > 0
    ? healthy
    : [...keys].sort((a, b) => (fails[a.keyId] ?? 0) - (fails[b.keyId] ?? 0));

  let lastError = "no key succeeded";
  for (const key of order) {
    let res: Attempt<T>;
    try {
      res = await attempt(key);
    } catch (err) {
      res = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    await reportKeyUse(
      key.keyId,
      provider,
      userId,
      res.ok ? "ok" : "fail",
      res.minutes ?? 0,
      res.status,
      res.ok ? undefined : res.detail,
    );
    if (res.ok) {
      return { ok: true, value: res.value, keyId: key.keyId, keyLabel: key.label, tried: keys.length };
    }
    lastError = res.detail ?? `status ${res.status ?? "?"}`;
  }

  return { ok: false, error: lastError, tried: keys.length };
}
