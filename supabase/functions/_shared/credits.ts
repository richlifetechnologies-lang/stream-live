// Credit + lease helpers shared by the Edge Functions.
//
// All money math lives in Postgres (see migrations/20261011000000_stream_live_credits.sql)
// so that two devices on one account can never spend the same minute twice. The
// functions here only call those RPCs with the service-role client and interpret
// the answers — they never touch balances directly.
import { adminClient } from "./db.ts";

export type Modality = "video" | "audio" | "video_audio";

/**
 * Desktop tab id -> credit bucket. The cloning side of the Video + Audio tab can run on its own,
 * with no picture on the cable, and that call is the audio line: same tab, same panel record,
 * different meter. Unknown tabs bill as the priciest bucket.
 */
export function modalityForTab(tab?: string, voiceOnly = false): Modality {
  if (tab === "video-only") return "video";
  if (tab === "audio-only") return "audio";
  if (tab === "video-audio" && voiceOnly) return "audio";
  return "video_audio";
}

/**
 * Which wallet a modality actually spends minutes from — the mirror of sl_pay_bucket on the
 * database, so a refusal read here and the charge taken there can never disagree. The modality
 * still decides the rate; only the pool is shared. Both cloning calls draw the one pool.
 */
export function payBucket(modality: Modality): Modality {
  return modality === "video_audio" || modality === "audio" ? "video" : modality;
}

/** The three positions of the cloning door. */
export type CloningMode = "off" | "voice_only" | "voice_video";

/** The account row as this file reads it — plus the cloning line when the database has it. */
type SubscriptionRow = {
  status: string;
  plan_id: string | null;
  video_enabled: boolean;
  audio_enabled: boolean;
  video_audio_enabled: boolean;
  max_concurrent_sessions: number | null;
  cloning_mode?: string | null;
  [key: string]: unknown;
};

/**
 * How far an account may clone, read off the two lines the database folds into one answer by
 * sl_cloning_mode: the whole-software line and the account's own, at their lowest common position.
 * Kept here because a refusal this early has to name the same door the dial itself is refused at.
 */
export function cloningMode(
  cfg: { cloning_mode?: string | null; cloning_enabled?: boolean | null } | null,
  sub: { cloning_mode?: string | null; video_audio_enabled?: boolean | null } | null,
): CloningMode {
  const rank = (m: unknown, fallback: CloningMode): CloningMode =>
    m === "off" || m === "voice_only" || m === "voice_video" ? m : fallback;
  // A boolean-only row can only ever have meant the two positions it was written with.
  const global = rank(cfg?.cloning_mode, cfg && cfg.cloning_enabled === false ? "off" : "voice_video");
  if (!sub) return "off";   // an account with no subscription row has been promised nothing
  const account = rank(sub.cloning_mode, sub.video_audio_enabled === false ? "off" : "voice_video");
  if (global === "off" || account === "off") return "off";
  if (global === "voice_only" || account === "voice_only") return "voice_only";
  return "voice_video";
}

export type Lease = {
  sessionId: string;
  modality: Modality;
  chunkMinutes: number;
  leaseExpiresAt: string | null;
  balance: number | null;
  unlimited: boolean;
  ttlSeconds: number;
  engine: "fal" | "decart";
};

type Rpc = { data: unknown; error: { message: string } | null };

function unwrap(res: Rpc): Record<string, never> {
  if (res.error) throw new Error(`rpc failed: ${res.error.message}`);
  return (res.data ?? {}) as Record<string, never>;
}

/** Account state the gateway needs before any AI call is allowed. */
export type AccountState = {
  ok: boolean;
  reason?: string;
  message?: string;
  status?: string;
  planId?: string;
  modality?: Modality;
  enabled?: boolean;
  /** How far this account may clone, once both lines have had their say. */
  cloningMode?: CloningMode;
  maxConcurrent?: number;
  balances?: Record<string, number | null>;
  minSupportedVersion?: string;
  latestVersion?: string;
  maintenance?: boolean;
  maintenanceMessage?: string;
};

/**
 * Read the account row + switches. Deliberately read-only: the atomic decision is
 * made inside sl_start_session, this only produces friendly reasons early.
 *
 * It does not check balances, because the amount a bucket needs to fund a call
 * depends on which engine serves it and only the database knows that: a trial
 * leftover of 53 seconds is spendable, a paid bucket under a minute is not. A
 * guessed floor here would refuse calls the gateway would have allowed.
 */
export async function readAccount(userId: string, modality: Modality): Promise<AccountState> {
  const db = adminClient();

  const { data: cfgRaw } = await db.from("app_config").select("*").eq("id", 1).maybeSingle();
  // The cloning line is asked for by name, and a database that has not run
  // 20261102120000 yet has no such column — naming a missing column fails the whole read, which
  // would refuse every call on the software. So the read falls back to the two figures the row has
  // always had, and sl_cloning_mode on the database makes the same fallback for the same reason.
  const subCols = "status, plan_id, video_enabled, audio_enabled, video_audio_enabled, max_concurrent_sessions";
  const withMode = await db
    .from("subscriptions")
    .select(`${subCols}, cloning_mode`)
    .eq("user_id", userId)
    .maybeSingle();
  const sub: SubscriptionRow | null = withMode.error
    ? (await db.from("subscriptions").select(subCols).eq("user_id", userId).maybeSingle()).data
    : withMode.data;
  const { data: wallets } = await db
    .from("credit_balances")
    .select("modality, balance, unlimited")
    .eq("user_id", userId);

  const enabledFlag =
    modality === "video" ? "video_enabled" : modality === "audio" ? "audio_enabled" : "video_audio_enabled";

  const balances: Record<string, number | null> = {};
  for (const w of wallets ?? []) {
    balances[w.modality as string] = w.unlimited ? null : Number(w.balance);
  }
  // One pool: whatever is watching a refusal reads the figure the call would have spent from,
  // never the row that no longer holds minutes.
  const pool = payBucket(modality);
  if (modality !== pool) balances[modality] = balances[pool] ?? 0;

  const state: AccountState = {
    ok: true,
    planId: sub?.plan_id,
    modality,
    enabled: sub ? sub[enabledFlag] === true : false,
    cloningMode: cloningMode(cfgRaw, sub),
    maxConcurrent: sub?.max_concurrent_sessions ?? 1,
    balances,
    minSupportedVersion: cfgRaw?.min_supported_version ?? "1.0.0",
    latestVersion: cfgRaw?.latest_version ?? undefined,
    maintenance: cfgRaw?.maintenance === true,
    maintenanceMessage: cfgRaw?.maintenance_message ?? undefined,
  };

  if (!sub) return { ...state, ok: false, reason: "no_subscription" };
  if (sub.status !== "active") return { ...state, ok: false, reason: `status_${sub.status}` };
  if (state.maintenance) return { ...state, ok: false, reason: "maintenance" };
  // ONE DOOR, THREE POSITIONS, for either cloning call. The whole-software line and the account's
  // own line are folded into one answer, exactly as sl_cloning_mode folds them, so a dial refused
  // here and the same dial refused inside the money function carry the same sentence.
  // 'voice_only' opens the voice side and keeps the Video + Audio tab dead.
  if (modality === "video_audio" && state.cloningMode !== "voice_video") {
    return { ...state, ok: false, reason: "clone_closed" };
  }
  if (modality === "audio" && state.cloningMode === "off") {
    return { ...state, ok: false, reason: "clone_closed" };
  }
  if (!state.enabled) return { ...state, ok: false, reason: "modality_disabled" };

  return state;
}

/** Open a metered lease. Returns null plus a reason when the wallet refuses. */
export async function startLease(
  userId: string,
  modality: Modality,
  tab: string,
  deviceId?: string,
): Promise<{ lease: Lease | null; reason?: string; detail?: unknown }> {
  const db = adminClient();
  const data = unwrap(
    await db.rpc("sl_start_session", {
      p_user: userId,
      p_modality: modality,
      p_tab: tab,
      p_device: deviceId ?? null,
    }),
  );

  if (data.allowed !== true) {
    return { lease: null, reason: String(data.reason ?? "denied"), detail: data };
  }
  return {
    lease: {
      sessionId: String(data.session_id),
      modality,
      chunkMinutes: Number(data.chunk_minutes ?? 0),
      leaseExpiresAt: data.lease_ttl_seconds
        ? new Date(Date.now() + Number(data.lease_ttl_seconds) * 1000).toISOString()
        : null,
      balance: data.balance === null || data.balance === undefined ? null : Number(data.balance),
      unlimited: data.unlimited === true,
      ttlSeconds: Number(data.lease_ttl_seconds ?? 120),
      engine: data.engine === "decart" ? "decart" : "fal",
    },
  };
}

/**
 * Renew or close a lease, or stamp the first frame. `ended` also comes back true when
 * the wallet ran dry.
 *
 * `media` moves no money: the database only records when the picture arrived, which is
 * where a video window is billed from. A lease that never got one is refunded in full.
 *
 * A renewal also says how many seconds the window it just bought pays for. It comes back
 * null when nothing is being counted down against - an unlimited bucket, or a video call
 * whose picture has not reached the screen yet - and null has to stay null, because zero
 * seconds means "cut the call now" to the app.
 */
export async function updateLease(
  sessionId: string,
  action: "renew" | "end" | "media",
): Promise<{ ok: boolean; ended: boolean; reason?: string; error?: string; balance: number | null; expiresAt: string | null; billed: number | null; fundedSeconds: number | null; ttlSeconds: number; unlimited: boolean }> {
  const db = adminClient();
  const data = unwrap(await db.rpc("sl_lease", { p_session_id: sessionId, p_action: action }));

  const ttl = Number(data.lease_ttl_seconds ?? 120);
  return {
    ok: data.ok === true,
    ended: data.ended === true,
    reason: data.reason ? String(data.reason) : undefined,
    error: data.error ? String(data.error) : undefined,
    balance: data.balance === null || data.balance === undefined ? null : Number(data.balance),
    expiresAt: data.ended === true ? null : new Date(Date.now() + ttl * 1000).toISOString(),
    billed: data.billed_minutes === undefined ? null : Number(data.billed_minutes),
    fundedSeconds: data.funded_seconds === null || data.funded_seconds === undefined
      ? null
      : Number(data.funded_seconds),
    ttlSeconds: ttl,
    unlimited: data.unlimited === true,
  };
}

/** Admin-side top-up / deduction. Returns the new balance. */
export async function grantCredits(
  userId: string,
  modality: Modality,
  minutes: number,
  reason: string,
  actorId?: string,
  opts: { requestId?: string; unlimited?: boolean | null } = {},
): Promise<Record<string, never>> {
  const db = adminClient();
  return unwrap(
    await db.rpc("sl_grant_credits", {
      p_user: userId,
      p_modality: modality,
      p_minutes: minutes,
      p_reason: reason,
      p_actor: actorId ?? null,
      p_request_id: opts.requestId ?? null,
      p_unlimited: opts.unlimited ?? null,
    }),
  );
}

export async function resolveRequest(
  requestId: string,
  approve: boolean,
  adminId: string,
  note?: string,
  minutes?: number,
): Promise<Record<string, never>> {
  const db = adminClient();
  return unwrap(
    await db.rpc("sl_resolve_request", {
      p_request_id: requestId,
      p_approve: approve,
      p_admin: adminId,
      p_note: note ?? null,
      p_minutes: minutes ?? null,
    }),
  );
}

/** Close leases that ran past their TTL (crash, closed app, lost network). */
export async function reapSessions(userId?: string): Promise<number> {
  const db = adminClient();
  const data = await db.rpc("sl_reap_sessions", { p_user: userId ?? null });
  if (data.error) throw new Error(`reap failed: ${data.error.message}`);
  return Number(data.data ?? 0);
}

/** Invalidate every session a user has, so a stolen/shared login dies everywhere. */
export async function signOutEverywhere(userId: string): Promise<number> {
  const db = adminClient();
  const data = await db.rpc("sl_sign_out_everywhere", { p_user: userId });
  if (data.error) throw new Error(`sign out failed: ${data.error.message}`);
  return Number(data.data ?? 0);
}
