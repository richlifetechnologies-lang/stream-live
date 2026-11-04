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
  /** Which stored account this key was found on, so its figure is fal's, not a guess. */
  account_id: string | null;
};

/**
 * One stored fal.ai account, read on its own.
 *
 * The balance belongs to the account, not to the key, so this is the unit the card
 * counts in: a second billing key from the SAME account would print the same balance
 * twice and lie about the money, which is why the table now refuses a duplicate key.
 */
export type FalAccountRow = {
  id: string;
  label: string;
  tail: string;
  keyId: string;
  /** fal's own preset for this key — BILLING reads, API can spend. Empty when fal's
   *  key list could not be read, which is not the same as an unknown preset. */
  preset: string;
  /** false when fal refused this account, so its nulls are a read failure, not a zero. */
  ok: boolean;
  balance: number | null;
  currency: string;
  today: FalSpend | null;
  month: FalSpend | null;
  warn_below: number | null;
  alert_below: number | null;
  minutes_left: number | null;
  detail: string;
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

/**
 * How long the gateway held a fal window that never showed a frame.
 *
 * A video call is billed from the first frame, so his customers are charged nothing
 * for these windows — but fal was asked to stream for them, and the seconds he pays
 * fal for are not the same clock. This is the one figure that says how much picture
 * nobody saw, so it can be watched week to week instead of dug out in an audit.
 */
export type FalWindowCount = {
  sessions: number;
  seconds: number;
};

/**
 * How long the gateway held a fal window that never showed a frame.
 *
 * A video call is billed to the customer from the first frame, so they are charged
 * nothing for these windows — but the seconds were still spent on fal's account.
 * This is the figure that says how much picture nobody saw, watchable week to week
 * instead of dug out in an audit.
 */
export type FalNoFrame = {
  today: FalWindowCount;
  month: FalWindowCount;
  /** Where the last day of blanks actually sits. Null when the read could not be taken. */
  blank: FalBlankSpread | null;
};

/** One machine's share of the last day of blank calls. */
export type FalBlankGroup = {
  /** The device the app booked the call on, shortened — the man reading this knows his own machines. */
  machine: string;
  calls: number;
  seconds: number;
  /** The account that was signed in on it. "several accounts" when more than one was. */
  who: string;
};

/**
 * Whether yesterday's blanks are his side of the cable or hers.
 *
 * The app writes the cause it proved onto the call it gave up on, and only two of the three
 * causes are anywhere a customer can reach. A day that reads "all his side" is a support
 * problem; a day that reads "all ours" is a supplier problem, and they are fixed in different
 * places. Null when no call in the window carried a cause — which is what every build before
 * the one that reports them leaves behind.
 */
export type FalBlankSpread = {
  calls: number;
  machines: number;
  accounts: number;
  worst: FalBlankGroup[];
  /**
   * `refused` is the part of `our_side` where the video service answered the dial itself with a
   * refusal — the number that says the line was full rather than that his machine was.
   */
  causes: { his_side: number; our_side: number; refused: number } | null;
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
  no_frame: FalNoFrame | null;
  checked_at: string;
  from_cache: boolean;
  detail: string;
  /**
   * Every stored account, each with fal's own figures for that account. The four
   * fields above are the sum of these, taken over the one window named here — never
   * one account's bill standing in for all of them, which is what a second key used
   * to do silently.
   */
  accounts: FalAccountRow[];
  /** The instantances every summed figure in this payload was measured between. */
  window: { start: string; month_start: string; end: string };
  /** The lowest an account has fallen: red beats amber, and the card names which. */
  alert: { level: "red" | "amber" | null; account: string };
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
 * The windows his own meter recorded as "never showed a frame", summed for today and
 * this month.
 *
 * Only a closed window is counted: a call still inside its lease may yet deliver the
 * first frame, and charging its waiting time to this line would invent a leak that has
 * not happened. The clock runs from the moment the gateway opened the session to the
 * earlier of the end the app reported and the expiry nobody renewed past. lease_started_
 * at is deliberately NOT the start — the settle writes it equal to the end, so using it
 * would make every closed window read zero seconds.
 */
async function noFrame(monthStart: string): Promise<FalNoFrame | null> {
  const db = adminClient();
  // Picture calls only. A voice-only session has no frame by design, so counting it here
  // would read as a video that failed to arrive; a row older than the modality column is
  // kept, because every call from that era sent a picture.
  const { data, error } = await db
    .from("usage_sessions")
    .select("started_at, lease_expires_at, ended_at, device_id, user_id")
    .eq("engine", "fal")
    .or("modality.is.null,modality.in.(video,video_audio)")
    .is("media_started_at", null)
    .gte("started_at", monthStart)
    .limit(5000);
  if (error) return null;

  const now = Date.now(), dayStart = Date.parse(utcDayStart());
  const since24 = now - 24 * 3600_000;
  const gap = { sessions: 0, seconds: 0 }, mon = { sessions: 0, seconds: 0 };
  const byMachine = new Map<string, { machine: string; calls: number; seconds: number; users: Set<string> }>();
  const accounts = new Set<string>();
  let calls24 = 0;
  for (const s of data ?? []) {
    const open = ms(s.started_at);
    if (open === null) continue;
    const closed = ms(s.ended_at) ?? ms(s.lease_expires_at);
    if (closed === null || closed > now || closed <= open) continue;
    const took = (closed - open) / 1000;
    mon.sessions += 1;
    mon.seconds += took;
    if (open >= dayStart) { gap.sessions += 1; gap.seconds += took; }
    if (open >= since24) {
      calls24 += 1;
      // The machine the app booked the call on, not the account: the same person on two
      // computers is two different cameras and two different networks, and this line exists
      // to find out whether one of them is the whole problem.
      const machine = String(s.device_id ?? "").slice(0, 12) || "(no machine id on the row)";
      const g = byMachine.get(machine) ?? { machine, calls: 0, seconds: 0, users: new Set<string>() };
      g.calls += 1;
      g.seconds += took;
      const u = String(s.user_id ?? "");
      if (u) { g.users.add(u); accounts.add(u); }
      byMachine.set(machine, g);
    }
  }
  const r = (v: number) => Math.round(v * 10) / 10;

  // What the app itself proved about each blank it gave up on. Rows only exist from the build
  // that started writing them, so an empty read is reported as no read at all rather than as
  // "nothing was his side", which is the wrong comfort to give a man deciding who to fix.
  let causes: { his_side: number; our_side: number } | null = null;
  const { data: fails } = await db
    .from("call_failures")
    .select("detail")
    .eq("stage", "engine")
    .gte("created_at", new Date(since24).toISOString())
    .limit(2000);
  const marked = (fails ?? []).filter(f => String(f.detail ?? "").includes("cause="));
  if (marked.length) {
    let his = 0, ours = 0, refused = 0;
    for (const f of marked) {
      const d = String(f.detail ?? "");
      // A refusal is counted on both lines it belongs to: it is ours, and it is the specific
      // kind of ours that a raise in the concurrent limit will not fix.
      if (d.includes("cause=line_full")) { ours += 1; refused += 1; }
      else if (d.includes("cause=picture_hold")) ours += 1;
      else if (d.includes("cause=camera_stalled") || d.includes("cause=never_connected")) his += 1;
    }
    causes = { his_side: his, our_side: ours, refused };
  }

  const named = [...byMachine.values()].sort((a, b) => b.calls - a.calls || b.seconds - a.seconds).slice(0, 3);
  const ids = [...new Set(named.flatMap(g => [...g.users]))];
  const emails = new Map<string, string>();
  if (ids.length) {
    const { data: people } = await db.from("profiles").select("id, email").in("id", ids).limit(ids.length);
    for (const p of people ?? []) emails.set(String(p.id), String(p.email ?? ""));
  }
  const blank: FalBlankSpread = {
    calls: calls24,
    machines: byMachine.size,
    accounts: accounts.size,
    worst: named.map(g => ({
      machine: g.machine,
      calls: g.calls,
      seconds: r(g.seconds),
      who: g.users.size === 0 ? "(no account on the row)"
        : g.users.size > 1 ? `${g.users.size} accounts`
        : emails.get([...g.users][0]) ?? "(account not listed)",
    })),
    causes,
  };

  return {
    today: { sessions: gap.sessions, seconds: r(gap.seconds) },
    month: { sessions: mon.sessions, seconds: r(mon.seconds) },
    blank,
  };
}

/**
 * One stored account, asked in the same breath as every other one.
 *
 * Four calls, all of them reads: the balance, today's spend, this month's spend and
 * fal's own key list. The key list is what makes a pool key's figure honest when
 * several accounts are stored — it says which account that key actually lives on, so
 * the spend is narrowed by the right secret instead of guessed at from the first one.
 */
async function readAccount(
  stored: { id: string; label: string; key: string; warn_below: number | null; alert_below: number | null },
  day: string,
  monthStart: string,
  end: string,
): Promise<{ row: FalAccountRow; keyIds: Set<string> }> {
  const [bal, today, month, known] = await Promise.all([
    falAccountBalance(stored.key),
    falSpend(stored.key, day, end),
    falSpend(stored.key, monthStart, end),
    falKeyList(stored.key),
  ]);
  const t = "err" in today ? null : today;
  const m = "err" in month ? null : month;
  const failed = "err" in bal ? bal.err : "err" in today ? today.err : "err" in month ? month.err : "";
  const perSec = m?.unitPrice ?? t?.unitPrice ?? null;
  return {
    row: {
      id: stored.id,
      label: stored.label,
      tail: tail(stored.key),
      keyId: stored.key.split(":")[0] ?? "",
      preset: "err" in known ? "" : (known.keys.find((k) => k.id === stored.key.split(":")[0])?.preset ?? ""),
      ok: !failed,
      balance: "err" in bal ? null : bal.balance,
      currency: "err" in bal ? "USD" : bal.currency,
      today: t,
      month: m,
      warn_below: stored.warn_below,
      alert_below: stored.alert_below,
      minutes_left: perSecondMinutes("err" in bal ? null : bal.balance, perSec),
      detail: failed || "read from fal.ai.",
    },
    keyIds: "err" in known ? new Set<string>() : new Set(known.keys.map((k) => k.id)),
  };
}

function perSecondMinutes(balance: number | null, perSecond: number | null): number | null {
  if (balance === null || !perSecond || perSecond <= 0) return null;
  return Math.floor(balance / perSecond / 60);
}

/**
 * The whole card in one call: every stored account's balance and spend, the same two
 * figures per stored key, and the totals the card prints above them.
 */
export async function falBalance(): Promise<FalBalancePayload> {
  // fal's balance is held for a minute; the meter is not. A reading served from cache
  // still has to say what the calls running right now have taken since that reading,
  // or the countdown would freeze at the figure fal answered with.
  if (cache && Date.now() - cache.at < cache.ttl) {
    const held = { ...cache.payload, from_cache: true };
    held.live = await liveBurn(held.per_second, held.checked_at);
    held.no_frame = await noFrame(utcMonthStart());
    return held;
  }

  const db = adminClient();
  const { data: stored, error: storedErr } = await db
    .from("fal_watch")
    .select("id, label, billing_key, warn_below, alert_below")
    .order("created_at", { ascending: true });
  const envKey = normalizeSecret(Deno.env.get("FAL_BILLING_KEY") ?? "");
  const wanted = (stored ?? [])
    .map((r) => ({
      id: String(r.id),
      label: String(r.label ?? ""),
      key: normalizeSecret(String(r.billing_key ?? "")),
      warn_below: r.warn_below == null ? null : num(r.warn_below),
      alert_below: r.alert_below == null ? null : num(r.alert_below),
    }))
    .filter((r) => r.key);
  // The env secret is a fallback, never a second account: it is the same credential
  // the rows carry when no row has been written yet, and counting it beside that row
  // would add one balance twice.
  const secrets = wanted.length
    ? wanted
    : envKey
      ? [{ id: "env", label: "the env secret", key: envKey, warn_below: null, alert_below: null }]
      : [];

  // One set of window edges for the whole reading, fixed before anything is asked, and
  // handed to the paid-call ledger too, so the two cards can never be comparing a
  // different day. Every account is measured between them, which is what lets the
  // summed bill be true.
  const day = utcDayStart(), monthStart = utcMonthStart(), end = new Date().toISOString();

  const base: FalBalancePayload = {
    ok: false,
    configured: secrets.length > 0,
    tail: "",
    label: "",
    warn_below: null,
    alert_below: null,
    balance: null,
    currency: "USD",
    today: null,
    month: null,
    per_second: null,
    per_second_source: null,
    minutes_left: null,
    keys: [],
    live: null,
    no_frame: null,
    checked_at: end,
    from_cache: false,
    accounts: [],
    window: { start: day, month_start: monthStart, end },
    alert: { level: null, account: "" },
    detail: secrets.length
      ? ""
      : "No billing key is stored yet. On fal.ai open dashboard → API Keys and create one with the BILLING preset — it can read a balance and cannot start a call, so it is safe to keep here. Paste it and Save.",
  };
  const keep = (payload: FalBalancePayload): FalBalancePayload => {
    cache = { at: Date.now(), ttl: payload.ok ? FRESH_MS : STALE_FAIL_MS, payload };
    return payload;
  };
  if (!secrets.length) return keep({ ...base, no_frame: await noFrame(monthStart) });

  const [cfg, nf, ...read] = await Promise.all([
    db.from("billing_config").select("lucy_video_per_sec_cost").eq("id", 1).maybeSingle(),
    noFrame(monthStart),
    ...secrets.map((s) => readAccount(s, day, monthStart, end)),
  ]);
  const accounts: FalAccountRow[] = read.map((r) => r.row);
  const one = accounts.length === 1 ? accounts[0] : null;

  // The figures the card prints in big are sums of the accounts that answered, over
  // these edges. An account that refused is named in detail, never counted as zero.
  const answered = accounts.filter((a) => a.balance !== null);
  const balance = answered.length ? Math.round(answered.reduce((a, x) => a + (x.balance ?? 0), 0) * 100) / 100 : null;
  const sum = (pick: (a: FalAccountRow) => FalSpend | null): FalSpend | null => {
    const got = accounts.map(pick).filter((s): s is FalSpend => !!s);
    if (!got.length) return null;
    return {
      cost: Math.round(got.reduce((a, s) => a + s.cost, 0) * 1e4) / 1e4,
      seconds: Math.round(got.reduce((a, s) => a + s.seconds, 0) * 10) / 10,
      unitPrice: got.map((s) => s.unitPrice).find((v) => v !== null && v > 0) ?? null,
      detail: `${got.length} of ${accounts.length} account(s) answered`,
    };
  };
  const today = sum((a) => a.today);
  const month = sum((a) => a.month);
  const bad = accounts.filter((a) => !a.ok);
  const failed = storedErr ? `the stored accounts could not be read: ${storedErr.message}` : bad.length
    ? bad.map((a) => `${a.label || a.tail}: ${a.detail}`).join("; ")
    : "";

  // His own Prices tab holds the rate he charges against, fal's usage row holds the
  // rate fal actually charges. fal wins when it answers, because the question this
  // number answers is how much CALLING is left, not how much it was sold for.
  const pg = num(cfg?.data?.lucy_video_per_sec_cost);
  const perSecond = month?.unitPrice ?? today?.unitPrice ?? (pg || null);
  const source = month?.unitPrice || today?.unitPrice ? "fal" : pg ? "prices tab" : null;

  // Which account each pool key actually lives on, off that account's own key list.
  const where = new Map<string, number>();
  read.forEach((r, i) => r.keyIds.forEach((id) => { if (!where.has(id)) where.set(id, i); }));
  const pool = await db
    .from("gateway_keys")
    .select("id, label, fal_key")
    .eq("enabled", true)
    .not("fal_key", "is", null)
    .order("priority", { ascending: true });
  const rows: FalKeyRow[] = await Promise.all(
    (pool.data ?? []).map(async (k) => {
      const keyId = normalizeSecret(String(k.fal_key ?? "")).split(":")[0] ?? "";
      const owner = where.get(keyId);
      // A key no account recognises is still asked about, against the first account, so
      // the row keeps a figure rather than a blank — and `known:false` says it is not a fact.
      const src = secrets[owner ?? 0];
      const [kt, km] = await Promise.all([falSpend(src.key, day, end, keyId), falSpend(src.key, monthStart, end, keyId)]);
      return {
        id: String(k.id),
        label: String(k.label ?? ""),
        keyId,
        tail: tail(String(k.fal_key ?? "")),
        known: owner !== undefined,
        account_id: owner === undefined ? null : accounts[owner].id,
        today: "err" in kt ? null : kt,
        month: "err" in km ? null : km,
      };
    }),
  );

  // The lowest an account has fallen. The big figure is a total and no account's
  // threshold describes a total, so the colour comes from the account that is actually
  // low and the card names it — a warning that colours $213 because $3 of it is low
  // would be the wrong comfort in the other direction.
  const low = (a: FalAccountRow) =>
    a.balance !== null && a.alert_below !== null && a.balance < a.alert_below ? "red"
      : a.balance !== null && a.warn_below !== null && a.balance < a.warn_below ? "amber"
      : null;
  const worst = accounts.reduce<{ level: "red" | "amber" | null, account: string }>((a, x) => {
    const l = low(x);
    if (!l) return a;
    if (a.level === "red") return a;
    return { level: l, account: x.label || x.tail };
  }, { level: null, account: "" });

  return keep({
    ...base,
    ok: !failed,
    tail: one ? one.tail : "",
    label: one ? one.label : "",
    warn_below: one ? one.warn_below : null,
    alert_below: one ? one.alert_below : null,
    balance,
    currency: answered[0]?.currency ?? "USD",
    today,
    month,
    per_second: perSecond,
    per_second_source: source,
    minutes_left: perSecondMinutes(balance, perSecond),
    keys: rows,
    accounts,
    alert: worst,
    live: await liveBurn(perSecond, base.checked_at),
    no_frame: nf,
    detail: failed || "All figures read from fal.ai.",
  });
}

