import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Hourglass, TriangleAlert } from "lucide-react";
import { bucketFor, refreshBalances, useAccount, useLease } from "../lib/gateway";
import { countdown, drainOf, MOD_LABELS } from "../lib/minutes";
import { t } from "../lib/i18n";
import type { Modality } from "@stream-live/client";

const C = "hsl(187 100% 52%)";
/** Below this the clock turns amber, because a top-up takes a human. */
export const LOW_MINUTES = 5;

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
 * on air it counts down every second and turns amber, then red, as the bucket
 * empties.
 *
 * The foot bar beside Start call cannot spare a card's height, so the same
 * clock comes in a pill: the number, and the drain bar under it once a call is
 * running.
 */
export function MinuteMeter({ modality, compact = false, note }: { modality: Modality; compact?: boolean; note?: string }) {
  const account = useAccount();
  const lease = useLease();
  const now = useTicker();
  const [, setLocation] = useLocation();

  const wallet = bucketFor(account, modality);
  const burnRate = wallet?.burnRate ?? 1;
  const drain = lease !== null && lease.modality === modality ? drainOf(lease, burnRate, now) : null;
  const running = drain !== null;
  const remaining = drain ? drain.remaining : (wallet?.unlimited ? null : wallet?.balance ?? 0);
  const unlimited = drain ? drain.unlimited : (wallet?.unlimited ?? false);
  // A bucket is empty at zero, not at "under one minute": a trial that has 53
  // seconds left can still start a video call, and telling him otherwise on the
  // clock makes a working account look dead.
  const empty = !unlimited && remaining !== null && remaining <= 0;
  // When the read itself failed the numbers on screen are the last ones that were true,
  // so the red "no minutes" alarm would be a lie — the honest line replaces it.
  const stale = account.error !== null;
  const low = !unlimited && remaining !== null && remaining < LOW_MINUTES;
  const tone = empty ? "hsl(0 85% 62%)" : low ? "hsl(35 100% 60%)" : C;
  const pct = !drain || unlimited || !lease
    ? 100
    : Math.max(0, Math.min(100, ((remaining ?? 0) / lease.startBalance) * 100));

  if (compact) {
    return (
      <div data-tour="meter" style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 12, background: "hsl(222 44% 8%)", border: `1px solid ${tone}44`, minWidth: 118 }}>
        <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", fontFamily: "'Orbitron',monospace", color: "hsl(222 25% 55%)", display: "flex", alignItems: "center", gap: 5 }}>
          <Hourglass style={{ width: 10, height: 10, color: tone }} />
          {t(MOD_LABELS[modality])} {running ? (drain.waiting ? t("starting up") : t("in use")) : t("available")}
        </p>
        <p style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 19, lineHeight: 1.15, color: tone, fontVariantNumeric: "tabular-nums" }}>
          {unlimited ? t("UNLIMITED") : countdown(remaining)}
        </p>
        {running && !unlimited && (
          <div style={{ height: 4, borderRadius: 2, overflow: "hidden", background: "hsl(222 40% 12%)" }}>
            <div style={{ width: `${pct}%`, height: "100%", borderRadius: 2, background: tone, transition: "width 0.9s linear" }} />
          </div>
        )}
      </div>
    );
  }

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
            {t(MOD_LABELS[modality])} {running ? (drain.waiting ? t("starting up") : t("in use")) : t("available")}
          </span>
        </div>

        <span style={{
          fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 21, lineHeight: 1,
          color: tone, fontVariantNumeric: "tabular-nums", letterSpacing: "0.02em",
          textShadow: low ? `0 0 14px ${tone}55` : "none",
        }}>
          {unlimited ? t("UNLIMITED") : countdown(remaining)}
        </span>

        {empty && !unlimited && !stale && (
          <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 700, color: tone, fontFamily: "'Rajdhani',sans-serif" }}>
            <TriangleAlert style={{ width: 12, height: 12 }} />
            {running ? t("Out of minutes — the call stops now") : t("No minutes left")}
          </span>
        )}

        <button onClick={() => setLocation("/minutes")}
          style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", padding: 0, color: tone, fontSize: 10.5, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", textDecoration: "underline" }}>
          {t("Minutes dashboard →")}
        </button>
      </div>

      {/* The one sentence about how this call type spends, before he presses Start.
          It steps aside once a call is running so the clock does not move the page. */}
      {note && !running && (
        <div style={{ marginTop: 9, paddingTop: 9, borderTop: "1px dashed hsl(187 100% 52% / 0.22)" }}>
          <p style={{ margin: 0, fontSize: 11, color: "hsl(187 60% 72%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5 }}>{note}</p>
        </div>
      )}

      {running && !unlimited && (
        <div style={{ marginTop: 9 }}>
          <div style={{
            height: 8, borderRadius: 5, overflow: "hidden",
            background: "hsl(222 40% 12%)", border: "1px solid hsl(222 40% 17%)",
          }}>
            <div style={{
              width: `${pct}%`, height: "100%", borderRadius: 5,
              background: `linear-gradient(90deg, ${tone}, hsl(200 100% 45%))`,
              boxShadow: low ? `0 0 14px ${tone}77` : "none",
              transition: "width 0.9s linear",
            }} />
          </div>
          <p style={{
            margin: "5px 0 0", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase",
            color: "hsl(222 25% 46%)", fontFamily: "'Orbitron',monospace", fontVariantNumeric: "tabular-nums",
          }}>
            {t("What is left")}
          </p>
        </div>
      )}

      {stale && (
        <p style={{ margin: "7px 0 0", fontSize: 10.5, color: "hsl(35 100% 70%)", fontFamily: "'Rajdhani',sans-serif" }}>
          {account.error}{" "}
          <button onClick={() => void refreshBalances()}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit",
              fontSize: "inherit", fontWeight: 700, fontFamily: "inherit", textDecoration: "underline" }}>
            {t("Try again")}
          </button>
        </p>
      )}

      {drain?.waiting && (
        <p style={{ margin: "7px 0 0", fontSize: 10.5, color: "hsl(187 60% 62%)", fontFamily: "'Rajdhani',sans-serif" }}>
          {t("Connecting — minutes start when your video appears.")}
        </p>
      )}

      {low && !empty && (
        <p style={{ margin: "7px 0 0", fontSize: 10.5, color: "hsl(35 100% 70%)", fontFamily: "'Rajdhani',sans-serif" }}>
          {t("Under {n} minutes left here. Ask your administrator to top up before the call drops.", { n: LOW_MINUTES })}
        </p>
      )}
    </div>
  );
}
