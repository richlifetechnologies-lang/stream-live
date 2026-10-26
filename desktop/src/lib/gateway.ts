import { useSyncExternalStore } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  StreamLiveClient,
  deviceIdFrom,
  type CallTicket,
  type LeaseState,
  type Modality,
  type TabName,
  type Wallet,
} from "@stream-live/client";
import { GATEWAY_CONFIG } from "./gateway-config";
import { CLOCK_NOTICE_MS, alignClock, clockSkewMs, describeClockSkew } from "./clock-sync";
import type { LiveLease } from "./minutes";
import type { AdminContact } from "@stream-live/client";

export type { LiveLease };

export type AccountState = {
  signedIn: boolean;
  email: string | null;
  wallets: Wallet[];
  loading: boolean;
  /**
   * Why the last read of the account failed, in the customer's own words, or null when
   * the numbers on screen are current. An account that cannot be read must say so: the
   * alternative is a meter sitting at zero, which a customer reads as "my minutes are
   * gone" when the truth is "the app could not ask".
   */
  error: string | null;
  /**
   * False while the account has only ever held its free trial minute. Starts true
   * so no upgrade copy can flash before the first snapshot lands.
   */
  paid: boolean;
  /** The metered lease this machine is holding right now, or null when idle. */
  live: LiveLease | null;
};

export const gateway = new StreamLiveClient(GATEWAY_CONFIG);

let state: AccountState = { signedIn: false, email: null, wallets: [], loading: true, error: null, paid: true, live: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<AccountState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getState(): AccountState {
  return state;
}

export function useAccount(): AccountState {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function useLease(): LiveLease | null {
  return useSyncExternalStore(subscribe, () => state.live, () => state.live);
}

/**
 * The administrator's own WhatsApp / Telegram handles, kept for the whole app rather
 * than fetched page by page.
 *
 * They arrive inside the account snapshot, so any screen that shows them needs a read
 * it would otherwise not make — and the sign-in screen cannot read them at all, because
 * a snapshot needs an account. Hence the last known pair is stored on this machine: a
 * customer who signed in once and came back locked out still finds the numbers waiting.
 */
const CONTACT_STORAGE = "ss_admin_contact";

function readStoredContact(): AdminContact | null {
  try {
    const raw = localStorage.getItem(CONTACT_STORAGE);
    return raw ? (JSON.parse(raw) as AdminContact) : null;
  } catch { return null; }
}

let adminContact: AdminContact | null = readStoredContact();
const contactListeners = new Set<() => void>();

function setAdminContact(next: AdminContact | null): void {
  // Handles that were never published must not wipe the pair from the last account
  // this machine saw — an empty read is not news, and the numbers on screen are real.
  if (!next || (!next.whatsapp && !next.telegram && !next.message)) return;
  adminContact = next;
  try { localStorage.setItem(CONTACT_STORAGE, JSON.stringify(next)); } catch { /**/ }
  contactListeners.forEach((l) => l());
}

export function useAdminContact(): AdminContact | null {
  return useSyncExternalStore(
    (cb) => { contactListeners.add(cb); return () => { contactListeners.delete(cb); }; },
    () => adminContact,
    () => adminContact,
  );
}

export function beginLease(ticket: CallTicket): void {
  const now = Date.now();
  setState({
    live: {
      sessionId: ticket.sessionId,
      modality: ticket.modality,
      balance: ticket.balance,
      unlimited: ticket.unlimited,
      billedMinutes: 0,
      startBalance: (ticket.balance ?? 0) + ticket.leaseMinutes,
      startedAt: now,
      observedAt: now,
      mediaAt: null,
      leaseExpiresAt: ticket.leaseExpiresAt,
      lowBalance: false,
    },
  });
}

/**
 * The engine put a picture on the screen: start the clock, here and at the gateway.
 * Called once per call, from whichever stream path renders the first remote frame.
 */
export function markMedia(): void {
  const prev = state.live;
  if (!prev || prev.mediaAt !== null) return;
  setState({ live: { ...prev, mediaAt: Date.now() } });
  // Until the gateway has the stamp it bills nothing, so a lost ping is a free call.
  // Retried while this same lease is live; a heartbeat that dies first ends the call.
  const send = (tries: number) => {
    void gateway.markMedia()
      .then((lease) => { if (lease?.ended) endLease(); })
      .catch(() => {
        if (tries > 0 && state.live?.sessionId === prev.sessionId) setTimeout(() => send(tries - 1), 5_000);
      });
  };
  // The gateway only bills from this stamp, so it closes a video call that never sent one.
  // Knocking for two minutes covers any stretch of bad network a real first frame could
  // survive, and it is one small idempotent request — a call that is working stops after the
  // first answer.
  send(24);
}

export function updateLease(sessionId: string, lease: LeaseState): void {
  const prev = state.live;
  if (!prev || prev.sessionId !== sessionId) return;
  setState({
    live: {
      ...prev,
      balance: lease.balance,
      unlimited: lease.unlimited,
      billedMinutes: lease.billedMinutes ?? prev.billedMinutes,
      observedAt: Date.now(),
      leaseExpiresAt: lease.leaseExpiresAt,
      lowBalance: lease.lowBalance,
    },
  });
}

export function endLease(): void {
  if (state.live) setState({ live: null });
}

export function modalityForTab(tab: TabName): Modality {
  if (tab === "video-only") return "video";
  if (tab === "audio-only") return "audio";
  return "video_audio";
}

export function bucketFor(state: AccountState, modality: Modality): Wallet | undefined {
  return state.wallets.find(w => w.modality === modality);
}

// A call is refused when its bucket cannot fund a lease; an unlimited bucket always passes.
// Video is the one bucket a free trial can leave partly spent, and the gateway lets a
// trial start on any amount above zero — so the button here must not be stricter than
// the wallet check behind it, or the leftover of a trial minute looks dead on screen.
export function hasMinutes(state: AccountState, modality: Modality): boolean {
  const w = bucketFor(state, modality);
  if (!w) return false;
  if (w.unlimited) return true;
  return modality === "video" ? w.balance > 0 : w.balance >= 1;
}

// A payment that reached Paystack while this app was closed has no other witness: the
// confirm page in the browser is gone, and the seller's call-back address is a box in
// somebody else's dashboard. So the app asks about its own account's unpaid-for orders
// whenever it next reads the meter, and the minutes appear on their own. Every few
// minutes is often enough for a human being, and keeps a live call from adding requests.
const RECONCILE_EVERY_MS = 5 * 60_000;
let lastReconcileAt = 0;

/** What a failed read of the account says to the customer. Never the server's own words. */
function plainReadError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (/signed out|not signed in/i.test(text)) return "Please sign in again.";
  if (/internet|network|failed to fetch|timeout|aborted/i.test(text)) {
    return "Your account could not be read — this computer is not reaching the server. Check the connection and try again.";
  }
  return "Your account could not be read just now. Nothing has happened to your minutes; try again in a moment.";
}

/**
 * One line in the app's own account.log.
 *
 * "I closed it and opened it and the meter was empty" was unanswerable because a failed
 * read left no trace — the message went to the screen and then to the next repaint. The
 * reason is written out so the file can be read later; it carries no token and no address.
 */
function logAccount(note: string): void {
  const api = (window as unknown as { electronAPI?: { logNote?: (n: string) => void } }).electronAPI;
  try { api?.logNote?.(note); } catch { /* a log must never break the meter */ }
}

/**
 * The video engine's own words about a call that never showed a picture.
 *
 * Until now that sentence existed only on the customer's screen for a second, and the
 * app hides engine wording there by design — so a call that failed for a reason nobody
 * could read left no trace at all, not on his panel and not in the database. This writes
 * it to a table only he can read. It is fire-and-forget in every direction: a failure to
 * report must never add a second problem to the one the customer already has.
 */
export function reportCallFailure(sessionId: string | null, stage: string, detail: string): void {
  void gateway.raw
    .rpc("sl_report_call_failure", { p_session_id: sessionId, p_stage: stage, p_detail: detail })
    .then(() => undefined, () => undefined);
  logAccount(`call failure reported (${stage}): ${detail}`);
}

// Once per program run: a machine that is hours off stays hours off, and the log is
// interesting for its first entry, not its hundredth.
let clockSkewLogged = false;

/**
 * Write a machine's clock error where the operator reads it, never on the customer's
 * screen. The app works from the gateway's clock, so there is nothing for the person
 * holding that computer to do.
 */
export function noteClockSkew(skewMs: number): void {
  if (Math.abs(skewMs) < CLOCK_NOTICE_MS || clockSkewLogged || !getState().signedIn) return;
  clockSkewLogged = true;
  void gateway.raw
    .rpc("sl_report_call_failure", {
      p_session_id: null,
      p_stage: "clock skew",
      p_detail: `This computer reads ${describeClockSkew(skewMs)} real time. The app is working from the gateway's clock, so calls are unaffected.`,
    })
    .then(() => undefined, () => undefined);
}

/**
 * Take the gateway's clock as the app's own, before this machine makes a single decision
 * with its own time. A computer running ahead refuses its call pass before it dials, and
 * a customer has no way to tell that from a dead video line — so the correction happens in
 * silence and nothing is asked of the person holding the computer.
 */
export async function syncClockWithServer(): Promise<number | null> {
  const skew = alignClock(await gateway.serverTime());
  if (skew !== null) noteClockSkew(skew);
  return skew;
}

/** The boot reading is taken before anyone is signed in, so it is written up once we know. */
function reportMeasuredSkew(): void {
  const skew = clockSkewMs();
  if (skew !== null) noteClockSkew(skew);
}

export async function refreshBalances(): Promise<void> {
  if (!state.signedIn) return;
  try {
    if (Date.now() - lastReconcileAt > RECONCILE_EVERY_MS) {
      lastReconcileAt = Date.now();
      // A payment service that is down must never stop the meter loading, so this is
      // asked for and dropped on the floor; the snapshot below is what matters here.
      await gateway.reconcilePayments().catch(() => 0);
    }
    // One snapshot carries both the buckets and the paid flag, so the upgrade copy and
    // the balances can never disagree. It speaks snake_case; the store does not.
    const s = await gateway.snapshot();
    setAdminContact(s.contact ?? s.app?.contact ?? null);
    setState({
      paid: s.paid,
      error: null,
      wallets: s.wallets.map(w => ({
        modality: w.modality,
        balance: Number(w.balance),
        unlimited: w.unlimited,
        burnRate: Number(w.burn_rate) || 1,
      })),
    });
  } catch (err) {
    // The last known balances stay on screen, but they are marked as not just read, so
    // nobody reads a stale number as a fresh one or a blank meter as an empty account.
    setState({ error: plainReadError(err) });
    logAccount(`balance read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The payment window has come back to the till with an order in its address.
 *
 * Nothing about the money is concluded here - the receipt page is the one that asks, and
 * the answer comes from this app's own server. Only the wait changes: the meter would
 * otherwise next look in five minutes, and somebody who has just paid should not have to
 * sit through that, or reopen the app, to find the minutes they bought.
 */
export function notePaymentReceipt(): void {
  lastReconcileAt = 0;
  void refreshBalances();
  // A credit can land a few seconds after the payment provider says the money is in, so
  // the meter looks twice more before it leaves the answer to the next scheduled read.
  setTimeout(() => void refreshBalances(), 4000);
  setTimeout(() => void refreshBalances(), 12000);
}

export async function deviceId(): Promise<string> {
  const api = (window as unknown as { electronAPI?: { getDeviceId?: () => Promise<string> } }).electronAPI;
  if (api?.getDeviceId) {
    try { return await api.getDeviceId(); } catch { /* fall through to browser seed */ }
  }
  // In a plain browser (vite dev) there is no machine id; derive a stable one from
  // the runtime fingerprint so device binding still works.
  return deviceIdFrom(`${navigator.platform}|${navigator.userAgent}`);
}

export async function restore(): Promise<Session | null> {
  const session = await gateway.restoreSession();
  if (!session) { setState({ signedIn: false, email: null, wallets: [], loading: false, paid: true }); return null; }
  setState({ signedIn: true, email: session.user.email ?? null, loading: false });
  reportMeasuredSkew();
  await refreshBalances();
  return session;
}

export async function signIn(email: string, password: string): Promise<Session> {
  const session = await gateway.signIn(email, password);
  setState({ signedIn: true, email: session.user.email ?? null, loading: false });
  reportMeasuredSkew();
  await refreshBalances();
  return session;
}

export async function signUp(email: string, password: string, displayName?: string): Promise<Session | null> {
  // The machine id travels with the account from its first moment, because the free
  // trial belongs to the computer rather than to the login. The server reads it and
  // decides there whether this machine has already had one; nothing here promises an
  // outcome, so a second account on the same PC simply finds no trial waiting.
  const session = await gateway.signUp(email, password, displayName, await deviceId());
  if (session) {
    setState({ signedIn: true, email: session.user.email ?? null, loading: false });
    reportMeasuredSkew();
    await refreshBalances();
  }
  return session;
}

export async function signOut(): Promise<void> {
  await gateway.signOut();
  setState({ signedIn: false, email: null, wallets: [], loading: false, paid: true, live: null });
}

export async function requestTopup(input: {
  modality: Modality;
  minutes: number;
  paymentChannel?: string;
  paymentReference?: string;
  note?: string;
}): Promise<void> {
  await gateway.requestTopup(input);
  await refreshBalances();
}

gateway.onChange((session) => {
  if (!session) setState({ signedIn: false, email: null, wallets: [], loading: false, paid: true, live: null });
});
