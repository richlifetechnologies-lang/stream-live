// ─────────────────────────────────────────────────────────────────────────────
// STREAM LIVE client — the account/credit gateway used by the Stream Studio
// desktop app and by the user web dashboard.
// ─────────────────────────────────────────────────────────────────────────────
// Replaces "the user pastes their own API key". The user signs in with an email
// and password; every AI call goes through the gateway, which mints a short-lived
// fal.ai JWT or proxies ElevenLabs audio. Master keys never reach this code.
//
// Wallet model (see supabase/migrations/20261011000000_stream_live_credits.sql):
//   three non-expiring buckets — video / audio / video_audio — topped up by an
//   administrator. A call opens a lease that pre-pays a small chunk of minutes and
//   is renewed by the heartbeat; the unused part is refunded when the call ends.
//   When a bucket runs dry the gateway says so and the call must stop.
//
// Requires @supabase/supabase-js.
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

export type Modality = "video" | "audio" | "video_audio";
export type TabName = "video-only" | "audio-only" | "video-audio";

export type GatewayConfig = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  falAppId: string;
  /** Desktop build version, checked against the gateway's minimum. */
  appVersion?: string;
};

export type Wallet = {
  modality: Modality;
  balance: number;
  unlimited: boolean;
  burnRate: number;
};

export type CallTicket = {
  sessionId: string;
  /** fal.ai JWT — null on the Audio Call tab, which needs no video pipeline. */
  token: string | null;
  modality: Modality;
  leaseExpiresAt: string | null;
  balance: number | null;
  unlimited: boolean;
  leaseMinutes: number;
  expiresInSeconds: number;
};

export type LeaseState = {
  ended: boolean;
  reason?: string;
  balance: number | null;
  unlimited: boolean;
  leaseExpiresAt: string | null;
  billedMinutes: number | null;
  lowBalance: boolean;
};

/** Gateway refused the call. `reason` is stable — map it to a message in the UI. */
export class GatewayError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly balances?: Record<string, number | null>;

  constructor(message: string, status: number, reason: string, balances?: Record<string, number | null>) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.balances = balances;
  }
}

const REASON_BY_STATUS: Record<number, string> = {
  401: "signed_out",
  402: "out_of_minutes",
  403: "not_entitled",
  409: "concurrent_limit",
  412: "update_required",
  503: "maintenance",
};

export class StreamLiveClient {
  private sb: SupabaseClient;
  private cfg: GatewayConfig;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;

  constructor(cfg: GatewayConfig) {
    this.cfg = cfg;
    this.sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }

  get raw(): SupabaseClient {
    return this.sb;
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  async signUp(email: string, password: string, displayName?: string): Promise<Session | null> {
    const { data, error } = await this.sb.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } },
    });
    if (error) throw error;
    return data.session;
  }

  async signIn(email: string, password: string): Promise<Session> {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (!data.session) throw new Error("sign-in did not return a session");
    return data.session;
  }

  async signOut(): Promise<void> {
    await this.endCall();
    await this.sb.auth.signOut();
  }

  async restoreSession(): Promise<Session | null> {
    const { data } = await this.sb.auth.getSession();
    return data.session;
  }

  onChange(cb: (session: Session | null) => void): () => void {
    const { data } = this.sb.auth.onAuthStateChange((_event, session) => cb(session));
    return () => data.subscription.unsubscribe();
  }

  async resetPassword(email: string): Promise<void> {
    const { error } = await this.sb.auth.resetPasswordForEmail(email);
    if (error) throw error;
  }

  private async token(): Promise<string> {
    const { data } = await this.sb.auth.getSession();
    if (!data.session) throw new GatewayError("not signed in", 401, "signed_out");
    return data.session.access_token;
  }

  // ── Wallet ─────────────────────────────────────────────────────────────────
  /** The three buckets, with the burn rate each one is charged at. */
  async wallets(): Promise<Wallet[]> {
    await this.token();
    const [balRes, ratesRes] = await Promise.all([
      this.sb.from("credit_balances").select("modality, balance, unlimited").order("modality"),
      this.sb.from("burn_rates").select("modality, multiplier").is("retired_at", null),
    ]);
    if (balRes.error) throw new Error(balRes.error.message);
    const rate = new Map<string, number>();
    for (const r of ratesRes.data ?? []) rate.set(r.modality as string, Number(r.multiplier));

    const seen = new Set<Modality>();
    const rows = (balRes.data ?? []).map((b) => {
      const m = b.modality as Modality;
      seen.add(m);
      return {
        modality: m,
        balance: Number(b.balance),
        unlimited: b.unlimited === true,
        burnRate: rate.get(m) ?? 1,
      } satisfies Wallet;
    });
    // Buckets the user has never touched do not exist yet — show them as zero.
    for (const m of ["video", "audio", "video_audio"] as Modality[]) {
      if (!seen.has(m)) rows.push({ modality: m, balance: 0, unlimited: false, burnRate: rate.get(m) ?? 1 });
    }
    return rows;
  }

  async ledger(limit = 50): Promise<Array<Record<string, unknown>>> {
    await this.token();
    const { data, error } = await this.sb
      .from("credit_ledger")
      .select("created_at, modality, kind, delta, balance_after, reason")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async devices(): Promise<Array<Record<string, unknown>>> {
    await this.token();
    const { data, error } = await this.sb
      .from("devices")
      .select("device_id, label, first_seen, last_seen, revoked")
      .eq("revoked", false)
      .order("last_seen", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /** Release a device slot. The row stays (revoked) so it can never re-bind silently. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.token();
    const { error } = await this.sb.from("devices").update({ revoked: true }).eq("device_id", deviceId);
    if (error) throw new Error(error.message);
  }

  /** Ask the administrator for minutes. Payment happens outside the software. */
  async requestTopup(input: {
    modality: Modality;
    minutes: number;
    paymentChannel?: string;
    paymentReference?: string;
    note?: string;
  }): Promise<void> {
    await this.token();
    if (!(input.minutes > 0)) throw new Error("Choose how many minutes to request.");
    const { error } = await this.sb.from("credit_requests").insert({
      modality: input.modality,
      minutes: input.minutes,
      payment_channel: input.paymentChannel ?? null,
      payment_reference: input.paymentReference ?? null,
      note: input.note ?? null,
    });
    if (error) throw new Error(error.message);
  }

  async myRequests(): Promise<Array<Record<string, unknown>>> {
    await this.token();
    const { data, error } = await this.sb
      .from("credit_requests")
      .select("id, modality, minutes, status, admin_note, created_at")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /** Gateway switches: minimum supported build, maintenance banner. */
  async appInfo(): Promise<{ minSupportedVersion: string; latestVersion: string | null; maintenance: boolean; maintenanceMessage: string | null }> {
    const { data, error } = await this.sb.from("app_config").select("*").eq("id", 1).single();
    if (error) throw new Error(error.message);
    return {
      minSupportedVersion: data.min_supported_version,
      latestVersion: data.latest_version,
      maintenance: data.maintenance === true,
      maintenanceMessage: data.maintenance_message,
    };
  }

  // ── Calls ──────────────────────────────────────────────────────────────────
  /**
   * Open a metered lease and, for the video modalities, get a short-lived fal JWT.
   * Throws GatewayError with reason out_of_minutes / concurrent_limit / device_* /
   * modality_disabled / update_required / maintenance.
   */
  async startCall(tab: TabName, deviceId?: string): Promise<CallTicket> {
    const res = await this.invoke("start-session", {
      appId: this.cfg.falAppId,
      tab,
      deviceId,
      appVersion: this.cfg.appVersion,
    });
    this.sessionId = res.sessionId;
    return {
      sessionId: res.sessionId,
      token: res.token ?? null,
      modality: res.modality,
      leaseExpiresAt: res.leaseExpiresAt,
      balance: res.balance ?? null,
      unlimited: res.unlimited === true,
      leaseMinutes: Number(res.leaseMinutes ?? 0),
      expiresInSeconds: Number(res.expiresInSeconds ?? 120),
    } satisfies CallTicket;
  }

  /**
   * Keep the call alive. The heartbeat must land before the lease expires or the
   * gateway closes the session and refunds the unused pre-payment.
   */
  beginHeartbeat(onState: (state: LeaseState) => void, intervalMs?: number): void {
    this.stopHeartbeat();
    const ms = intervalMs ?? 45_000;
    this.heartbeat = setInterval(
      () => void this.ping().then((state) => { if (state) onState(state); }).catch(() => null),
      ms,
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  async ping(): Promise<LeaseState | null> {
    if (!this.sessionId) return null;
    const res = await this.invoke("lease", { sessionId: this.sessionId, action: "renew" });
    return {
      ended: res.ended === true,
      reason: res.reason,
      balance: res.balance === null || res.balance === undefined ? null : Number(res.balance),
      unlimited: res.unlimited === true,
      leaseExpiresAt: res.leaseExpiresAt ?? null,
      billedMinutes: res.billedMinutes === undefined ? null : Number(res.billedMinutes),
      lowBalance: res.lowBalance === true,
    } satisfies LeaseState;
  }

  /** Close the lease and refund whatever was pre-paid but unused. */
  async endCall(): Promise<LeaseState | null> {
    this.stopHeartbeat();
    const id = this.sessionId;
    this.sessionId = null;
    if (!id) return null;
    const res = await this.invoke("lease", { sessionId: id, action: "end" });
    return {
      ended: true,
      balance: res.balance === null || res.balance === undefined ? null : Number(res.balance),
      unlimited: res.unlimited === true,
      leaseExpiresAt: null,
      billedMinutes: res.billedMinutes === undefined ? null : Number(res.billedMinutes),
      lowBalance: false,
    } satisfies LeaseState;
  }

  /**
   * ElevenLabs through the gateway. `sessionId` is required for speech-to-speech /
   * text-to-speech (it proves the call is being metered); voice-library calls pass none.
   *
   * A FormData body must arrive at ElevenLabs as the exact multipart payload the
   * browser would have sent, so it is serialised here and carried as base64 —
   * re-encoding it server-side would lose the boundary and the file bytes.
   */
  async voice(
    path: string,
    body?: FormData | Record<string, unknown> | string,
    opts: { isStream?: boolean; method?: "POST" | "GET"; sessionId?: string | null } = {},
  ): Promise<Response> {
    const token = await this.token();
    const payload: Record<string, unknown> = {
      path,
      method: opts.method ?? (body === undefined ? "GET" : "POST"),
      isStream: opts.isStream ?? false,
      sessionId: opts.sessionId ?? this.sessionId ?? undefined,
    };

    if (body instanceof FormData) {
      const form = new Request("https://stream-live.local/form", { method: "POST", body });
      const bytes = new Uint8Array(await form.arrayBuffer());
      payload.multipart = {
        contentType: form.headers.get("content-type") ?? "multipart/form-data",
        bodyBase64: toBase64(bytes),
      };
    } else if (typeof body === "string") {
      payload.text = body;
    } else if (body !== undefined) {
      payload.json = body;
    }

    return fetch(`${this.cfg.supabaseUrl}/functions/v1/proxy-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
  }

  /** Admin panel bridge (403 unless profiles.is_admin). */
  async admin<T = Record<string, unknown>>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    return (await this.invoke("admin-api", { action, ...payload })) as T;
  }

  // ── Internals ──────────────────────────────────────────────────────────────
  private async invoke(fn: string, body: Record<string, unknown>): Promise<Record<string, never>> {
    const token = await this.token();
    const res = await fetch(`${this.cfg.supabaseUrl}/functions/v1/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: text };
    }
    if (!res.ok) {
      const reason = String(parsed?.reason ?? REASON_BY_STATUS[res.status] ?? "gateway_error");
      throw new GatewayError(String(parsed?.error ?? `${fn} failed`), res.status, reason, parsed?.balances as never);
    }
    return parsed as Record<string, never>;
  }
}

function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Stable per-machine id for device binding (Electron machineId / hostname + mac). */export function deviceIdFrom(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return "dev_" + (h >>> 0).toString(16).padStart(8, "0");
}

export const REASON_MESSAGES: Record<string, string> = {
  out_of_minutes: "You have no minutes left in this bucket. Ask your administrator to top it up.",
  concurrent_limit: "This account is already calling on another device.",
  device_limit_reached: "This account has reached its device limit. Remove a device first.",
  device_revoked: "This device was revoked by the administrator.",
  modality_disabled: "That call type is not enabled on your account.",
  no_subscription: "This account has no plan yet. Contact your administrator.",
  status_canceled: "This account was cancelled by the administrator.",
  status_past_due: "This account is on hold. Contact your administrator.",
  status_expired: "This account is inactive. Contact your administrator.",
  update_required: "This version of Stream Studio is no longer supported. Update to continue.",
  maintenance: "The service is under maintenance. Try again shortly.",
  signed_out: "Please sign in again.",
  upstream_key: "The service is temporarily unavailable. Try again shortly.",
};
