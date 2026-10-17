// ─────────────────────────────────────────────────────────────────────────────
// STREAM LIVE client — the account/credit gateway used by the Stream Live
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
  /** Video token for this lease — null on the Audio Call tab, which needs no video pipeline. */
  token: string | null;
  /**
   * Which video pipeline the gateway put this lease on. Internal plumbing only:
   * it must never reach the screen, a toast or a log line a user can read.
   */
  engine: "fal" | "decart";
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

export type SnapshotWallet = {
  modality: Modality;
  balance: number;
  unlimited: boolean;
  total_credited: number;
  total_spent: number;
  burn_rate: number;
};

export type SnapshotSession = {
  id: string;
  tab: TabName;
  device_id: string | null;
  started_at: string;
  lease_expires_at: string | null;
  real_minutes: number;
};

/** Where the user pays, typed by the administrator on the panel's Contact tab. */
export type AdminPayment = { momo: string | null; btc: string | null };

/**
 * What the online payment service sells right now, and where it lives. The address
 * comes back from the service itself — the app never stores a payment address, so a
 * page that moves is followed without a new build and without anybody retyping it.
 */
export type CheckoutInfo = {
  enabled: boolean;
  page: string;
  currency: string;
  /** Cedi price per package, as the payment page will actually charge it. */
  prices: Record<string, number>;
};

/** The administrator's contact centres — WhatsApp and Telegram, nothing else. */
export type AdminContact = {
  message: string | null;
  whatsapp: string | null;
  telegram: string | null;
};

/** One package as the buyer sees it. Price is always USD. */
export type Plan = {
  id: string;
  name: string;
  priceCents: number;
  blurb: string | null;
  includes: string[];
  features: string[];
  maxDevices: number;
  /** Minutes attached to the package per modality — what the admin credits on purchase. */
  minutes: Record<Modality, number>;
};

/** One round-trip to `sl_account_snapshot` — what the user dashboard shows. */
export type AccountSnapshot = {
  status: string;
  /**
   * False while the account has only ever held its free trial minute. The upgrade
   * copy on screen is tied to this, so a snapshot that predates the field has to
   * read as paid — hiding a promise is better than making it to someone who has
   * already paid.
   */
  paid: boolean;
  planId: string | null;
  modalities: Record<Modality, boolean>;
  maxConcurrentSessions: number;
  wallets: SnapshotWallet[];
  openSessions: SnapshotSession[];
  app: { min_supported_version: string; latest_version: string | null; maintenance: boolean; maintenance_message: string | null; contact?: AdminContact | null; pay?: AdminPayment | null } | null;
  contact: AdminContact | null;
  pay: AdminPayment | null;
};

/** Postgres returns the snapshot as loose JSON; this is the shape we read from it. */
type SnapshotJson = {
  ok?: boolean;
  error?: string;
  status?: string;
  paid?: boolean;
  plan_id?: string;
  modalities?: Partial<Record<Modality, boolean>>;
  max_concurrent_sessions?: number;
  wallets?: SnapshotWallet[];
  open_sessions?: SnapshotSession[];
  app?: AccountSnapshot["app"];
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

/** A stored sign-in this close to death is traded in before it is presented. */
const TOKEN_REFRESH_MARGIN_MS = 120_000;

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
  private pingFailures = 0;
  private sessionId: string | null = null;
  private pendingEnd: string | null = null;
  private shopCache: { at: number; info: CheckoutInfo } | null = null;
  /** One token exchange at a time; the refresh ticket is only spendable once. */
  private refreshing: Promise<string | null> | null = null;

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
  /**
   * Create the account. `deviceId` is the same machine id the app sends when a call
   * starts, carried here so the server can give the free trial to the computer rather
   * than to the account — otherwise one machine can register its way to a trial every
   * time. The server decides on its own what to do with it; this client promises
   * nothing about the outcome.
   */
  async signUp(email: string, password: string, displayName?: string, deviceId?: string): Promise<Session | null> {
    const { data, error } = await this.sb.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName, device_id: deviceId } },
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
    // Never let an unreachable gateway block the sign-out. The lease stays pending
    // and is handed back on the next call from this machine.
    await this.endCall().catch(() => {});
    this.pendingEnd = null;
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

  /**
   * The sign-in token the app presents to every read, and the exchange that trades the
   * refresh ticket for a fresh one before the stored token dies. Without that exchange
   * an install-over-update leaves the app running on a token that expired while no copy
   * of it was open: every screen that reads the account then gets the server's technical
   * refusal instead of the customer's own balances, and only signing out and back in
   * clears it. Costs one round trip an hour, so the account always loads by itself.
   */
  private async token(): Promise<string> {
    const { data } = await this.sb.auth.getSession();
    if (!data.session) throw new GatewayError("not signed in", 401, "signed_out");
    const expiresAt = Number(data.session.expires_at ?? 0);
    if (expiresAt > 0 && expiresAt * 1000 - Date.now() < TOKEN_REFRESH_MARGIN_MS) {
      const fresh = await this.refreshToken();
      if (fresh) return fresh;
    }
    return data.session.access_token;
  }

  private refreshToken(): Promise<string | null> {
    if (!this.refreshing) {
      this.refreshing = this.sb.auth
        .refreshSession()
        .then(({ data, error }) => (!error && data.session ? data.session.access_token : null))
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  private async userId(): Promise<string> {
    const { data } = await this.sb.auth.getSession();
    if (!data.session) throw new GatewayError("not signed in", 401, "signed_out");
    return data.session.user.id;
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

  /** Balances, what the account may use, spend totals and live sessions in one read. */
  async snapshot(): Promise<AccountSnapshot> {
    await this.token();
    const { data, error } = await this.sb.rpc("sl_account_snapshot");
    if (error) throw new Error(error.message);
    const j = (data ?? {}) as SnapshotJson;
    if (j.ok !== true) throw new Error(String(j.error ?? "snapshot unavailable"));

    const wallets = j.wallets ?? [];
    const seen = new Set<Modality>();
    for (const w of wallets) seen.add(w.modality);
    // A bucket the user has never been credited does not exist in the table yet.
    for (const m of ["video", "audio", "video_audio"] as Modality[]) {
      if (!seen.has(m)) wallets.push({ modality: m, balance: 0, unlimited: false, total_credited: 0, total_spent: 0, burn_rate: 1 });
    }

    return {
      status: j.status ?? "none",
      paid: j.paid !== false,
      planId: j.plan_id ?? null,
      modalities: {
        video: j.modalities?.video === true,
        audio: j.modalities?.audio === true,
        video_audio: j.modalities?.video_audio === true,
      },
      maxConcurrentSessions: Number(j.max_concurrent_sessions ?? 1),
      wallets,
      openSessions: j.open_sessions ?? [],
      app: j.app ?? null,
      contact: j.app?.contact ?? null,
      pay: j.app?.pay ?? null,
    };
  }

  /**
   * The packages on sale, cheapest first. Prices and the "what's included" text
   * are typed by the administrator; nothing here grants minutes — it is the
   * catalogue the user reads before paying outside the app.
   */
  async plans(): Promise<Plan[]> {
    await this.token();
    const { data, error } = await this.sb
      .from("plans")
      .select("id, name, price_cents, blurb, includes, features, max_devices, video_minutes, audio_minutes, video_audio_minutes")
      .eq("active", true)
      .order("price_cents", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((p) => ({
      id: String(p.id),
      name: String(p.name ?? p.id),
      priceCents: Number(p.price_cents ?? 0),
      blurb: (p.blurb as string | null) ?? null,
      includes: ((p.includes as string[] | null) ?? []).filter((x) => String(x).trim().length > 0),
      features: (p.features as string[] | null) ?? [],
      maxDevices: Number(p.max_devices ?? 1),
      minutes: {
        video: Number(p.video_minutes ?? 0),
        audio: Number(p.audio_minutes ?? 0),
        video_audio: Number(p.video_audio_minutes ?? 0),
      },
    }));
  }

  /**
   * The online payment shelf. A null answer means there is no online door: the service
   * is not deployed, is switched off, or did not answer. Nothing here throws, because
   * somebody reading prices must never be blocked by the payment service being down.
   */
  async checkout(): Promise<CheckoutInfo | null> {
    // Three screens ask for the shelf at once and the watermark banner asks on every
    // mount, so one answer is kept for a minute rather than fetched each time.
    if (this.shopCache && Date.now() - this.shopCache.at < 60_000) return this.shopCache.info;
    let j: Record<string, unknown>;
    try {
      const token = await this.token();
      const res = await fetch(`${this.cfg.supabaseUrl}/functions/v1/paystack-checkout`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      j = await res.json() as Record<string, unknown>;
    } catch {
      return null;
    }
    const page = String(j.page ?? "");
    if (!/^https:\/\/\S+$/.test(page)) return null;
    const prices: Record<string, number> = {};
    for (const p of (Array.isArray(j.packages) ? j.packages as Array<Record<string, unknown>> : [])) {
      const cents = Number(p.price_ghp ?? 0);
      // The shelf lists every package the seller has, including one he has not finished
      // setting up. Only what the server itself offers for sale gets a price here, so the
      // app can never put a Buy button on a package the payment page would refuse.
      if (cents > 0 && p.buyable !== false) prices[String(p.id)] = Math.round(cents) / 100;
    }
    const info: CheckoutInfo = { enabled: j.enabled === true, page, currency: String(j.currency ?? "GHS"), prices };
    this.shopCache = { at: Date.now(), info };
    return info;
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

  /** Ask the administrator for minutes. Payment happens outside the software. */
  async requestTopup(input: {
    modality: Modality;
    minutes: number;
    paymentChannel?: string;
    paymentReference?: string;
    note?: string;
  }): Promise<void> {
    const id = await this.userId();
    if (!(input.minutes > 0)) throw new Error("Choose how many minutes to request.");
    const { error } = await this.sb.from("credit_requests").insert({
      user_id: id,
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
   * Open a metered lease and, for the video modalities, get the short-lived token
   * for whichever video pipeline this account runs on.
   * Throws GatewayError with reason out_of_minutes / concurrent_limit / device_* /
   * modality_disabled / update_required / maintenance.
   */
  async startCall(tab: TabName, deviceId?: string): Promise<CallTicket> {
    // A Stop whose hand-back never landed leaves this id behind. Send it again now:
    // it cannot disturb the call about to open (ending an already-closed session is a
    // no-op server-side), and it returns the minutes the abandoned lease is holding.
    if (this.pendingEnd) void this.sendEnd(this.pendingEnd);
    this.pendingEnd = null;

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
      engine: res.engine === "decart" ? "decart" : "fal",
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
    this.pingFailures = 0;
    this.heartbeat = setInterval(() => {
      void this.ping()
        .then((state) => {
          this.pingFailures = 0;
          if (state) onState(state);
        })
        .catch(() => {
          // A heartbeat that never lands means the lease is dying: the gateway
          // closes the session, refunds the unused chunk, and refuses further AI
          // calls. Two misses is enough to know that — reporting it lets the app
          // end the call cleanly instead of streaming against a closed lease
          // until the upstream cuts it off.
          this.pingFailures++;
          if (this.pingFailures < 2) return;
          this.stopHeartbeat();
          onState({
            ended: true,
            reason: "lease_expired",
            balance: null,
            unlimited: false,
            leaseExpiresAt: null,
            billedMinutes: null,
            lowBalance: false,
          });
        });
    }, ms);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  async ping(): Promise<LeaseState | null> {
    if (!this.sessionId) return null;
    const res = await this.invoke("lease", { sessionId: this.sessionId, action: "renew" });
    return this.leaseState(res);
  }

  /**
   * Tell the gateway a picture is on screen. A video lease bills nothing until this
   * lands, so the call that never connects costs the customer no minutes. Fire it once,
   * at the first frame; repeat calls are ignored by the gateway.
   */
  async markMedia(): Promise<LeaseState | null> {
    if (!this.sessionId) return null;
    const res = await this.invoke("lease", { sessionId: this.sessionId, action: "media" });
    return this.leaseState(res);
  }

  private leaseState(res: Record<string, never>): LeaseState {
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
    const id = this.sessionId ?? this.pendingEnd;
    this.sessionId = null;
    if (!id) return null;
    // Held until the gateway confirms it, so the next call can hand the same ticket
    // back. See startCall.
    this.pendingEnd = id;
    const res = await this.sendEnd(id);
    if (!res) throw new Error("could not reach the gateway to end the call");
    this.pendingEnd = null;
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
   * Closing a lease is the only thing that ends it server-side, and losing that
   * request used to lose the session id with it: a Stop during a network blip or an
   * Edge Function cold start left the lease open for its whole TTL, and the next
   * Start was told the machine was already on a call. Retry once for the cold start,
   * and report failure instead of forgetting the id.
   */
  private async sendEnd(id: string): Promise<Record<string, never> | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.invoke("lease", { sessionId: id, action: "end" });
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1_200));
      }
    }
    return null;
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

/** feature_flag values worded for the buyer instead of the enum label. */
export const FEATURE_LABELS: Record<string, string> = {
  video: "AI video calls",
  voice: "AI voice cloning and calls",
  portrait_obs: "Portrait 9:16 OBS output",
};

/** Package prices are stored in cents and are always USD. */
export function usd(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(cents / 100) ? 0 : 2,
    maximumFractionDigits: 2,
  });
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
  update_required: "This version of Stream Live is no longer supported. Update to continue.",
  maintenance: "The service is under maintenance. Try again shortly.",
  signed_out: "Please sign in again.",
  upstream_key: "The service is temporarily unavailable. Try again shortly.",
};
