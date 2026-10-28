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
  /**
   * The instant the airtime the gateway has already paid for runs out, on this machine's
   * clock, or null while the gateway has not named one. The gateway only bills whole windows
   * it pre-pays, so past this instant the call is on air for nothing: the countdown below is
   * an estimate of the same bound, and this one is the server's own number.
   */
  fundedUntilAt: number | null;
  /** What the bucket held when the call opened, so the bar can show the drain. */
  startBalance: number;
  startedAt: number;
  observedAt: number;
  /**
   * When the engine's picture first reached the screen, or null while it has not.
   * A video call bills from here, not from startedAt.
   */
  mediaAt: number | null;
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
  /** A video call that has not shown a frame yet: connected, but not on air. */
  waiting: boolean;
};

/**
 * Minutes remaining, drained by the burn rate since the last heartbeat. The
 * gateway bills in lease windows, so the UI interpolates what the next settle
 * will say and the number moves every second rather than every 45.
 *
 * For video the clock is held at the frame, not at the dial-tone: the gateway
 * charges the same way, so nothing is spent — and nothing appears to be spent —
 * while the engine is still starting up or has failed to start at all.
 */
export function drainOf(lease: LiveLease, burnRate: number, now: number): Drain {
  const waiting = lease.modality !== "audio" && lease.mediaAt === null;
  const gate = Math.max(lease.observedAt, lease.mediaAt ?? now);
  const airAt = lease.modality === "audio" ? lease.startedAt : (lease.mediaAt ?? now);
  const drift = (Math.max(0, now - gate) / 60000) * burnRate;
  const used = lease.billedMinutes + drift;
  return {
    // The lease is bought out of the wallet in one chunk, so `balance` is what is
    // LEFT UNCOMMITTED - a trial that spends its whole minute on one call sits at
    // zero there while the call is paid for and running. What the customer can
    // still use is everything the wallet held when the call started, minus what
    // this call has cost.
    remaining: lease.unlimited ? null : Math.max(0, lease.startBalance - used),
    used,
    live: Math.max(0, (now - airAt) / 60000),
    unlimited: lease.unlimited,
    waiting,
  };
}

/** 7.25 → "7:15" — minutes and seconds, the way a countdown should read. */
export function countdown(mins: number | null): string {
  if (mins === null) return "∞";
  const total = Math.max(0, Math.floor(mins * 60));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The second this call has to stop, on this machine's clock, or a past second for one that
 * has already run out.
 *
 * The gateway buys each window in front of the call and answers a renewal with the seconds
 * that window pays for, counted from the instant it starts - and a renewal never buys more
 * than the wallet holds. So that answer is the real bound, and it moves only when a
 * heartbeat reaches the wallet: lose the heartbeat and the call stops with the airtime that
 * was actually paid for, instead of running unbilled until the engine gives up.
 *
 * Before the first renewal - and for a video call still waiting for its picture, where the
 * server names no bound because nothing is being spent - there is only the meter's own
 * estimate, so that is what gets armed. `minFundedMs` keeps a call opened on the last sliver
 * of change on screen for its first seconds rather than dropping it like a failure.
 */
export function stopDeadlineAt(
  lease: LiveLease,
  burnRate: number,
  now: number,
  minFundedMs: number,
): number {
  const drain = drainOf(lease, burnRate, now);
  const airStart = lease.modality === "audio" ? lease.startedAt : (lease.mediaAt ?? lease.startedAt);
  // Only an unlimited bucket reports a null countdown, and the caller does not arm a timer
  // for one, so this never has to time anything but a real number of minutes.
  const remaining = drain.remaining ?? 0;
  const paidUntil = lease.fundedUntilAt ?? (now + (remaining * 60_000) / burnRate);
  return Math.max(paidUntil, airStart + minFundedMs);
}
