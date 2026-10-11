import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Hourglass, TriangleAlert } from "lucide-react";
import { bucketFor, useAccount, useLease, type LiveLease } from "../lib/gateway";
import type { Modality } from "@stream-live/client";

const C = "hsl(187 100% 52%)";
const LOW = 5;

export const MOD_LABELS: Record<Modality, string> = {
  video: "Video Call",
  audio: "Audio Call",
  video_audio: "Video + Audio",
};

/** Seconds since the gateway last settled this lease, for the between-heartbeat drain. */
function secondsSince(observedAt: number, now: number): number {
  return Math.max(0, (now - observedAt) / 1000);
}

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
 * gateway bills in 45-second windows, so the ticker interpolates what the next
 * settle will say — the number moves every second, not every 45.
 */
export function drainOf(lease: LiveLease, burnRate: number, now: number): Drain {
  const drift = (secondsSince(lease.observedAt, now) / 60) * burnRate;
  const remaining = lease.unlimited ? null : Math.max(0, (lease.balance ?? 0) - drift);
  return {
    remaining,
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

/** Re-render on a fixed beat so derived values can use Date.now(). */
export function useTicker(periodMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [periodMs]);
  return now;
}

/**
 * The user's minute clock. Idle it states what the current tab can still buy;
 * streaming it counts down in real time and turns amber, then red, as the
 * bucket empties.
 */
export function MinuteMeter({ modality }: { modality: Modality }) {
  const account = useAccount();
  const lease = useLease();
  const now = useTicker();
  const [, setLocation] = useLocation();

  const wallet = bucketFor(account, modality);
  const burnRate = wallet?.burnRate ?? 1;
  const running = lease !== null && lease.modality === modality;
  const drain = running ? drainOf(lease!, burnRate, now) : null;
  const remaining = drain ? drain.remaining : (wallet?.unlimited ? null : wallet?.balance ?? 0);
  const unlimited = drain ? drain.unlimited : (wallet?.unlimited ?? false);
  const empty = !unlimited && remaining !== null && remaining < 1;
  const low = !unlimited && remaining !== null && remaining < LOW;
  const tone = empty ? "hsl(0 85% 62%)" : low ? "hsl(35 100% 60%)" : C;
  const pct = !running || unlimited || lease!.startBalance <= 0
    ? 100
    : Math.max(0, Math.min(100, ((remaining ?? 0) / lease!.startBalance) * 100));

  const link = (
    <button onClick={() => setLocation("/minutes")}
      style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: tone, fontSize: 10.5, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", textDecoration: "underline" }}>
      Minutes dashboard →
    </button>
  );

  return (
    <div style={{
      marginBottom: 8, padding: "10px 14px", borderRadius: 12,
      background: "hsl(228 62% 4% / 0.86)", backdropFilter: "blur(10px)",
      border: `1px solid ${tone}44`,
      boxShadow: low ? `0 0 22px ${tone}26` : "0 8px 22px hsl(226 80% 2% / 0.45)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <Hourglass style={{ width: 13, height: 13, color: tone, flexShrink: 0 }} />
          <span style={{
            fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
            fontFamily: "'Orbitron',monospace", color: "hsl(222 25% 55%)", whiteSpace: "nowrap",
          }}>
            {MOD_LABELS[modality]} {running ? "in use" : "available"}
          </span>
        </div>

        <span style={{
          fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 21, lineHeight: 1,
          color: tone, fontVariantNumeric: "tabular-nums", letterSpacing: "0.02em",
          textShadow: low ? `0 0 14px ${tone}55` : "none",
        }}>
          {unlimited ? "UNLIMITED" : countdown(remaining)}
        </span>

        {!unlimited && !empty && (
          <span style={{ fontSize: 10, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif" }}>
            min{running ? (burnRate === 1 ? "" : ` · ${burnRate}× rate`) : ""}
          </span>
        )}

        {empty && !unlimited && (
          <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 700, color: tone, fontFamily: "'Rajdhani',sans-serif" }}>
            <TriangleAlert style={{ width: 12, height: 12 }} />
            {running ? "Out of minutes — the call stops now" : "No minutes in this bucket"}
          </span>
        )}

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {running && (
            <>
              <Stat label="this call" value={`${countdown(drain!.used)} min`} />
              <Stat label="on air" value={clock(drain!.live)} />
            </>
          )}
          {link}
        </div>
      </div>

      {running && !unlimited && (
        <div style={{ marginTop: 8, height: 3, borderRadius: 2, background: "hsl(222 40% 12%)", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", borderRadius: 2, background: `linear-gradient(90deg, ${tone}, hsl(200 100% 45%))`, transition: "width 0.9s linear" }} />
        </div>
      )}

      {low && !empty && (
        <p style={{ margin: "7px 0 0", fontSize: 10.5, color: "hsl(35 100% 70%)", fontFamily: "'Rajdhani',sans-serif" }}>
          Under {LOW} minutes left here. Ask your administrator to top up before the call drops.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "right" }}>
      <p style={{ margin: 0, fontSize: 8.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "hsl(222 25% 42%)", fontFamily: "'Orbitron',monospace" }}>{label}</p>
      <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "hsl(190 80% 88%)", fontFamily: "'Orbitron',monospace", fontVariantNumeric: "tabular-nums" }}>{value}</p>
    </div>
  );
}

/** 90.5 minutes → "1:30:30" wall clock. */
function clock(mins: number): string {
  const total = Math.floor(mins * 60);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
