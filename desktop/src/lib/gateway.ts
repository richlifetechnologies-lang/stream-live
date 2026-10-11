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

export type AccountState = {
  signedIn: boolean;
  email: string | null;
  wallets: Wallet[];
  loading: boolean;
  /** The metered lease this machine is holding right now, or null when idle. */
  live: LiveLease | null;
};

/**
 * What the gateway last said about the running call. Balances only move when a
 * heartbeat settles a window, so the UI fills the gaps with the bucket's burn
 * rate and gets a smooth per-second countdown out of a 45-second poll.
 */
export type LiveLease = {
  sessionId: string;
  modality: Modality;
  balance: number | null;
  unlimited: boolean;
  billedMinutes: number;
  /** What the bucket held when the call opened, so the bar can show the drain. */
  startBalance: number;
  startedAt: number;
  observedAt: number;
  leaseExpiresAt: string | null;
  lowBalance: boolean;
};

export const gateway = new StreamLiveClient(GATEWAY_CONFIG);

let state: AccountState = { signedIn: false, email: null, wallets: [], loading: true, live: null };
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
      leaseExpiresAt: ticket.leaseExpiresAt,
      lowBalance: false,
    },
  });
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

// A call is refused when its bucket holds under one minute; an unlimited bucket always passes.
export function hasMinutes(state: AccountState, modality: Modality): boolean {
  const w = bucketFor(state, modality);
  if (!w) return false;
  return w.unlimited || w.balance >= 1;
}

export async function refreshBalances(): Promise<void> {
  if (!state.signedIn) return;
  try { setState({ wallets: await gateway.wallets() }); } catch { /* keep last known balances */ }
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
  if (!session) { setState({ signedIn: false, email: null, wallets: [], loading: false }); return null; }
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
  const session = await gateway.signUp(email, password, displayName);
  if (session) {
    setState({ signedIn: true, email: session.user.email ?? null, loading: false });
    await refreshBalances();
  }
  return session;
}

export async function signOut(): Promise<void> {
  await gateway.signOut();
  setState({ signedIn: false, email: null, wallets: [], loading: false, live: null });
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
  if (!session) setState({ signedIn: false, email: null, wallets: [], loading: false, live: null });
});
