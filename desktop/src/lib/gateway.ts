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
import type { LiveLease } from "./minutes";

export type { LiveLease };

export type AccountState = {
  signedIn: boolean;
  email: string | null;
  wallets: Wallet[];
  loading: boolean;
  /**
   * False while the account has only ever held its free trial minute. Starts true
   * so no upgrade copy can flash before the first snapshot lands.
   */
  paid: boolean;
  /** The metered lease this machine is holding right now, or null when idle. */
  live: LiveLease | null;
};

export const gateway = new StreamLiveClient(GATEWAY_CONFIG);

let state: AccountState = { signedIn: false, email: null, wallets: [], loading: true, paid: true, live: null };
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
        if (tries > 0 && state.live?.sessionId === prev.sessionId) setTimeout(() => send(tries - 1), 3_000);
      });
  };
  send(3);
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

export async function refreshBalances(): Promise<void> {
  if (!state.signedIn) return;
  // One snapshot carries both the buckets and the paid flag, so the upgrade copy and
  // the balances can never disagree. It speaks snake_case; the store does not.
  try {
    const s = await gateway.snapshot();
    setState({
      paid: s.paid,
      wallets: s.wallets.map(w => ({
        modality: w.modality,
        balance: Number(w.balance),
        unlimited: w.unlimited,
        burnRate: Number(w.burn_rate) || 1,
      })),
    });
  } catch { /* keep last known balances */ }
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
  await refreshBalances();
  return session;
}

export async function signIn(email: string, password: string): Promise<Session> {
  const session = await gateway.signIn(email, password);
  setState({ signedIn: true, email: session.user.email ?? null, loading: false });
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
