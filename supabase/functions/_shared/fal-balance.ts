// The money side of fal.ai, read from the server.
//
// The panel cannot do this itself: fal's billing endpoints need a fal secret, and
// the browser only ever holds the publishable anon key. So the read lives here,
// behind admin-api's requireAdmin, and the pasted key goes straight back out of the
// response as a tail — the same deal the key pool already makes with inference keys.
//
// The key used here is NOT an inference key. It must carry the BILLING preset, which
// can read a balance and a usage figure and cannot open a call, which is exactly why
// it is stored in fal_watch and never in gateway_keys: sl_pick_keys walks gateway_keys
// and would happily hand a billing key to a live call, and that call would fail.
//
// Two numbers come out of this and they must never be merged into one, because they
// are not the same thing:
//   * the account balance — fal reports one figure per account, not per key
//   * today's spend — filterable per key, so it can be smaller than the account
//     figure when a retired key did some of the burning.
import { adminClient } from "./db.ts";
import { normalizeSecret } from "./keys.ts";

const API = "https://api.fal.ai/v1";
// fal's own figures settle a little after a call ends, and the panel polls the keys
// tab every fifteen seconds. Asking fal that often buys nothing and risks a 429 on a
// read that exists to be glanced at, so one reading is served to everyone for a minute.
const FRESH_MS = 60_000;
// A failed read is not cached as long: the button he presses next should really try.
const STALE_FAIL_MS = 15_000;

export type FalSpend = {
  cost: number;
  seconds: number;
  /** fal's own per-second price for the realtime model, when a row carries one. */
  unitPrice: number | null;
  detail: string;
};

export type FalKeyRow = {
  id: string;
  label: string;
  tail: string;
  /** fal's key id — the half of the stored credential before the colon. */
  keyId: string;
  /** false when fal holds no such key, so the row's zero is a warning, not a fact. */
  known: boolean;
  today: FalSpend | null;
  month: FalSpend | null;
};

export type FalLiveKey = {
  id: string;
  /** Seconds of compute this key has taken since the reading above. */
  seconds: number;
  /** Calls on this key still running at the moment of the read. */
  running: number;
};

/**
 * What his own meter has booked since fal was asked.
 *
 * fal answers once a minute and its figures settle late, so between two readings the
 * account balance on screen is stale by exactly the calls running right now. This is
 * the missing piece: the gateway's own lease rows say who is streaming, on which key,
 * and from what instant, so the card can count that money off between polls instead of
 * waiting for fal. It is an estimate by construction and the next reading replaces it.
 */
export type FalLive = {
  /** The instant fal's snapshot was taken; everything after it is counted, not read. */
  since: string;
  /** Calls running at that instant — the rate the balance is falling at. */
  running: number;
  /** Seconds of paid compute all keys have taken since that instant. */
  seconds: number;
  dollars: number;
  keys: FalLiveKey[];
  /** Seconds burned by a call whose serving key was never recorded. */
  untracked: number;
};

export type FalBalancePayload = {
  ok: boolean;
  /** Nothing to ask fal with: no fal_watch row and no FAL_BILLING_KEY secret. */
  configured: boolean;
  tail: string;
  label: string;
  warn_below: number | null;
  alert_below: number | null;
  balance: number | null;
  currency: string;
  today: FalSpend | null;
  month: FalSpend | null;
  /** What one minute of paid video costs him, so the card can say minutes, not dollars. */
  per_second: number | null;
  per_second_source: "fal" | "prices tab" | null;
  minutes_left: number | null;
  keys: FalKeyRow[];
  live: FalLive | null;
  checked_at: string;
  from_cache: boolean;
  detail: string;
};

async function ask(key: string, path: string): Promise<{ res: Response; json: any } | { err: string; status: number | null }> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { headers: { Authorization: `Key ${key}` } });
  } catch (err) {
    return { err: `could not reach fal.ai: ${err instanceof Error ? err.message : String(err)}`, status: null };
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 180);
    let why = body;
    try { why = String(JSON.parse(body)?.detail ?? body); } catch { /**/ }
    return { err: `fal.ai answered ${res.status}${why ? `: ${why}` : ""}`, status: res.status };
  }
  return { res, json: await res.json().catch(() => ({})) };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Balance in the account's own currency. One call, and it cannot spend anything. */
export async function falAccountBalance(secret: string): Promise<{ balance: number; currency: string } | { err: string }> {
  const key = normalizeSecret(secret);
  const got = await ask(key, "/account/billing?expand=credits");
  if ("err" in got) return { err: got.err };
  const credits = got.json?.credits;
  const balance = Number(credits?.current_balance);
  if (!Number.isFinite(balance)) return { err: `fal.ai answered 200 but sent no balance (${JSON.stringify(got.json).slice(0, 120)})` };
  return { balance, currency: String(credits?.currency ?? "USD") };
}

/** Spend between two UTC instants, optionally narrowed to one key. */
export async function falSpend(
  secret: string,
  start: string,
  end: string,
  apiKeyId?: string,
): Promise<FalSpend | { err: string }> {
  const key = normalizeSecret(secret);
  const filter = apiKeyId ? `&api_key_id=${encodeURIComponent(apiKeyId)}` : "";
  const got = await ask(key, `/models/usage?expand=summary&start=${start}&end=${end}${filter}`);
  if ("err" in got) return { err: got.err };
  const rows: any[] = Array.isArray(got.json?.summary) ? got.json.summary : [];
  let cost = 0, seconds = 0, unitPrice: number | null = null;
  for (const r of rows) {
    cost += num(r.cost_total);
    if (String(r.unit ?? "").toLowerCase().startsWith("second")) seconds += num(r.quantity);
    // LUCY realtime is what this product burns. A second model on the same account
    // has its own price, so the one used for "minutes of calls left" is that row's.
    if (unitPrice === null && /lucy/i.test(String(r.endpoint_id ?? ""))) unitPrice = num(r.unit_price) || null;
  }
  return {
    cost: Math.round(cost * 1e4) / 1e4,
    seconds: Math.round(seconds * 10) / 10,
    unitPrice,
    detail: rows.length ? `${rows.length} priced ${rows.length === 1 ? "model" : "models"} in the window` : "no chargeable usage in the window",
  };
}

export type FalKeyMeta = { id: string; preset: string; alias: string };

/**
 * fal's own key list. Two jobs: tell a stored pool key that is no longer on the
 * account from one that simply had a quiet day, and tell the panel whether the key
 * it is about to store can spend money (API preset) or only read it (BILLING).
 */
export async function falKeyList(secret: string): Promise<{ keys: FalKeyMeta[] } | { err: string }> {
  const got = await ask(normalizeSecret(secret), "/keys");
  if ("err" in got) return { err: got.err };
  const list: any[] = Array.isArray(got.json?.keys) ? got.json.keys : [];
  return {
    keys: list.map((k) => ({
      id: String(k.key_id ?? ""),
      preset: String(k.preset ?? k.mode ?? "").toUpperCase(),
      alias: String(k.alias ?? ""),
    })),
  };
}

function utcDayStart(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
}
function utcMonthStart(): string {
  return `${new Date().toISOString().slice(0, 7)}-01T00:00:00Z`;
}

function tail(secret: string): string {
  const s = normalizeSecret(secret);
  return s.length <= 4 ? "••••" : `••••${s.slice(-4)}`;
}

/** So a caller that just stored a key can say which one it stored without echoing it. */
export const falKeyTail = tail;

let cache: { at: number; ttl: number; payload: FalBalancePayload } | null = null;

/** Drop the served reading: called after the key or the thresholds are written. */
export function forgetFalBalance(): void {
  cache = null;
}

function ms(v: unknown): number | null {
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * Count what the gateway's own leases have burned since fal was last asked.
 *
 * The billing clock is the one the settle already uses: a video call is metered from
 * the first frame, an audio call from the window start. A lease nobody renewed stopped
 * at its expiry even while the row waits for the reaper, so counting it past that
 * instant would invent a burn fal never charged.
 */
async function liveBurn(perSecond: number | null, since: string): Promise<FalLive | null> {
  if (!perSecond || perSecond <= 0) return null;
  const db = adminClient();
  const { data } = await db
    .from("usage_sessions")
    .select("id, fal_key_id, started_at, lease_started_at, lease_expires_at, media_started_at, ended_at")
    .eq("engine", "fal")
    .or(`ended_at.is.null,ended_at.gte.${since}`)
    .order("started_at", { ascending: false })
    .limit(500);

  const now = Date.now(), sinceMs = Date.parse(since);
  const byKey = new Map<string, FalLiveKey>();
  let seconds = 0, running = 0, untracked = 0;

  for (const s of data ?? []) {
    const billFrom = ms(s.media_started_at) ?? ms(s.lease_started_at) ?? ms(s.started_at);
    if (billFrom === null || Number.isNaN(sinceMs)) continue;
    const ended = ms(s.ended_at);
    const stop = Math.min(now, ended ?? ms(s.lease_expires_at) ?? now);
    const took = Math.max(0, (stop - Math.max(billFrom, sinceMs)) / 1000);
    if (took === 0 && ended !== null) continue;
    seconds += took;
    if (ended === null && stop >= now - 1000) running += 1;
    const keyId = String(s.fal_key_id ?? "");
    if (!keyId) { untracked += took; continue; }
    const hit = byKey.get(keyId) ?? { id: keyId, seconds: 0, running: 0 };
    hit.seconds = Math.round((hit.seconds + took) * 10) / 10;
    if (ended === null && stop >= now - 1000) hit.running += 1;
    byKey.set(keyId, hit);
  }

  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    since,
    running,
    seconds: r(seconds),
    dollars: Math.round(seconds * perSecond * 1e4) / 1e4,
    keys: [...byKey.values()],
    untracked: r(untracked),
  };
}

/**
 * The whole card in one call: balance, what fal charged since UTC midnight and since
 * the first of the month, and the same two figures per stored key.
 */
export async function falBalance(): Promise<FalBalancePayload> {
  // fal's balance is held for a minute; the meter is not. A reading served from cache
  // still has to say what the calls running right now have taken since that reading,
  // or the countdown would freeze at the figure fal answered with.
  if (cache && Date.now() - cache.at < cache.ttl) {
    const held = { ...cache.payload, from_cache: true };
    held.live = await liveBurn(held.per_second, held.checked_at);
    return held;
  }

  const db = adminClient();
  const { data: row } = await db
    .from("fal_watch")
    .select("label, billing_key, warn_below, alert_below")
    .limit(1)
    .maybeSingle();
  const envKey = normalizeSecret(Deno.env.get("FAL_BILLING_KEY") ?? "");
  const secret = normalizeSecret(String(row?.billing_key ?? "")) || envKey;

  const base: FalBalancePayload = {
    ok: false,
    configured: !!secret,
    tail: secret ? tail(secret) : "",
    label: String(row?.label ?? (envKey ? "the env secret" : "")),
    warn_below: row?.warn_below == null ? null : num(row.warn_below),
    alert_below: row?.alert_below == null ? null : num(row.alert_below),
    balance: null,
    currency: "USD",
    today: null,
    month: null,
    per_second: null,
    per_second_source: null,
    minutes_left: null,
    keys: [],
    live: null,
    checked_at: new Date().toISOString(),
    from_cache: false,
    detail: secret
      ? ""
      : "No billing key is stored yet. On fal.ai open dashboard → API Keys and create one with the BILLING preset — it can read a balance and cannot start a call, so it is safe to keep here. Paste it and Save.",
  };
  const keep = (payload: FalBalancePayload): FalBalancePayload => {
    cache = { at: Date.now(), ttl: payload.ok ? FRESH_MS : STALE_FAIL_MS, payload };
    return payload;
  };
  if (!secret) return keep(base);

  // One set of window edges for the whole reading, so the per-key figures can never
  // add up to a different day than the account figure above them.
  const day = utcDayStart(), monthStart = utcMonthStart(), end = new Date().toISOString();
  const [bal, today, month, known, cfg] = await Promise.all([
    falAccountBalance(secret),
    falSpend(secret, day, end),
    falSpend(secret, monthStart, end),
    falKeyList(secret),
    db.from("billing_config").select("lucy_video_per_sec_cost").eq("id", 1).maybeSingle(),
  ]);
  if ("err" in bal) return keep({ ...base, detail: `${bal.err}. The key stored ends ${base.tail}.` });

  const t = "err" in today ? null : today;
  const m = "err" in month ? null : month;
  const failed = "err" in today ? today.err : "err" in month ? month.err : "";

  // His own Prices tab holds the rate he charges against, fal's usage row holds the
  // rate fal actually charges. fal wins when it answers, because the question this
  // number answers is how much CALLING is left, not how much it was sold for.
  const pg = num(cfg?.data?.lucy_video_per_sec_cost);
  const perSecond = m?.unitPrice ?? t?.unitPrice ?? (pg || null);
  const source = m?.unitPrice || t?.unitPrice ? "fal" : pg ? "prices tab" : null;

  const onAccount = "err" in known ? null : new Set(known.keys.map((k) => k.id));
  const pool = await db
    .from("gateway_keys")
    .select("id, label, fal_key")
    .eq("enabled", true)
    .not("fal_key", "is", null)
    .order("priority", { ascending: true });
  const rows: FalKeyRow[] = await Promise.all(
    (pool.data ?? []).map(async (k) => {
      const keyId = normalizeSecret(String(k.fal_key ?? "")).split(":")[0] ?? "";
      const [kt, km] = await Promise.all([falSpend(secret, day, end, keyId), falSpend(secret, monthStart, end, keyId)]);
      return {
        id: String(k.id),
        label: String(k.label ?? ""),
        keyId,
        tail: tail(String(k.fal_key ?? "")),
        known: onAccount === null || onAccount.has(keyId),
        today: "err" in kt ? null : kt,
        month: "err" in km ? null : km,
      };
    }),
  );

  return keep({
    ...base,
    ok: !failed,
    balance: bal.balance,
    currency: bal.currency,
    today: t,
    month: m,
    per_second: perSecond,
    per_second_source: source,
    minutes_left: perSecond && perSecond > 0 ? Math.floor(bal.balance / perSecond / 60) : null,
    keys: rows,
    live: await liveBurn(perSecond, base.checked_at),
    detail: failed || "All figures read from fal.ai.",
  });
}
