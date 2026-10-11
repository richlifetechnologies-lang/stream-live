import type { Modality } from "@stream-live/client";

export const MOD_LABELS: Record<Modality, string> = {
  video: "Video Call",
  audio: "Audio Call",
  video_audio: "Video + Audio",
};

/**
 * What the gateway last said about the running call, plus the clock needed to
 * fill the gaps between its 45-second settles.
 */
export type LiveLease = {
  sessionId: string;
  modality: Modality;
  /** Wallet minutes in the bucket at the last gateway read. */
  balance: number | null;
  unlimited: boolean;
  /** Wallet minutes this call has been charged for so far. */
  billedMinutes: number;
  /** What the bucket held when the call opened, so the bar can show the drain. */
  startBalance: number;
  startedAt: number;
  observedAt: number;
  leaseExpiresAt: string | null;
  lowBalance: boolean;
};

export type Drain = {
  /** Wallet minutes left, or null when the bucket is unlimited. */
  remaining: number | null;
  /** Wallet minutes this call has cost so far. */
  used: number;
  /** Wall-clock minutes the call has been running. */
  live: number;
  unlimited: boolean;
};

/**
 * Minutes remaining, drained by the burn rate since the last heartbeat. The
 * gateway bills in lease windows, so the UI interpolates what the next settle
 * will say and the number moves every second rather than every 45.
 */
export function drainOf(lease: LiveLease, burnRate: number, now: number): Drain {
  const drift = (Math.max(0, now - lease.observedAt) / 60000) * burnRate;
  return {
    remaining: lease.unlimited ? null : Math.max(0, (lease.balance ?? 0) - drift),
    used: lease.billedMinutes + drift,
    live: Math.max(0, (now - lease.startedAt) / 60000),
    unlimited: lease.unlimited,
  };
}

/** 7.25 → "7:15" — minutes and seconds, the way a countdown should read. */
export function countdown(mins: number | null): string {
  if (mins === null) return "∞";
  const total = Math.max(0, Math.floor(mins * 60));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
