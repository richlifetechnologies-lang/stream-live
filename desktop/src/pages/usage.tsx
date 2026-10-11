import { useState, useEffect } from "react";
import { AppLayout } from "../components/layout";
import { Zap, Clock, DollarSign, Activity, Trash2, TrendingUp } from "lucide-react";
import {
  subscribeLiveSession,
  getLiveSession,
  getPastSessions,
  clearSessionHistory,
  type LiveSession,
  type PastSession,
} from "../lib/session-store";

const C = "hsl(187 100% 52%)";
const BG = "hsl(222 47% 4%)";

function formatTime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m ${sec.toString().padStart(2, "0")}s`;
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function StatCard({
  icon: Icon, label, value, sub, color = C, glow = false,
}: {
  icon: React.ElementType; label: string; value: string; sub?: string;
  color?: string; glow?: boolean;
}) {
  return (
    <div style={{
      background: "hsl(222 44% 6%)",
      border: `1px solid ${glow ? color + "44" : "hsl(222 40% 11%)"}`,
      borderRadius: 14, padding: "18px 20px",
      boxShadow: glow ? `0 0 28px ${color}18` : "none",
      display: "flex", alignItems: "flex-start", gap: 14,
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: 10, flexShrink: 0,
        background: `${color}15`, border: `1px solid ${color}33`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <Icon style={{ width: 18, height: 18, color }} />
      </div>
      <div>
        <p style={{ fontSize: 10, fontWeight: 700, color: "hsl(222 25% 45%)", textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", marginBottom: 4 }}>{label}</p>
        <p style={{ fontSize: 22, fontWeight: 700, color: glow ? color : "hsl(190 80% 96%)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.04em", lineHeight: 1 }}>{value}</p>
        {sub && <p style={{ fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 4 }}>{sub}</p>}
      </div>
    </div>
  );
}

export default function UsagePage() {
  const [live, setLive] = useState<LiveSession>(getLiveSession);
  const [history, setHistory] = useState<PastSession[]>(getPastSessions);

  useEffect(() => {
    const unsub = subscribeLiveSession(s => {
      setLive(s);
      if (!s.isActive) setHistory(getPastSessions());
    });
    return unsub;
  }, []);

  const totalCredits = history.reduce((a, s) => a + s.credits, 0);
  const totalUsd     = history.reduce((a, s) => a + s.usd, 0);
  const totalSecs    = history.reduce((a, s) => a + s.durationSecs, 0);

  const handleClear = () => {
    if (!confirm("Clear all session history? This cannot be undone.")) return;
    clearSessionHistory();
    setHistory([]);
  };

  return (
    <AppLayout>
      <div style={{ padding: "28px 32px", maxWidth: 900, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 20, letterSpacing: "0.06em", color: "hsl(190 80% 96%)", marginBottom: 4 }}>
            Usage & Billing
          </h1>
          <p style={{ color: "hsl(222 25% 50%)", fontSize: 14, fontFamily: "'Rajdhani',sans-serif" }}>
            Track your Decart credits and streaming costs in real time
          </p>
        </div>

        {/* Live session banner */}
        {live.isActive && (
          <div style={{
            marginBottom: 24, padding: "16px 20px", borderRadius: 14,
            background: "hsl(187 100% 52% / 0.07)",
            border: "1px solid hsl(187 100% 52% / 0.35)",
            boxShadow: "0 0 32px hsl(187 100% 52% / 0.1)",
            display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: "hsl(0 85% 65%)", animation: "pulse 2s ease-in-out infinite", flexShrink: 0 }} />
              <span style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 11, letterSpacing: "0.1em", color: "hsl(0 85% 70%)" }}>LIVE NOW</span>
            </div>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap", flex: 1 }}>
              <div>
                <p style={{ fontSize: 10, color: "hsl(187 100% 52% / 0.6)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.1em", marginBottom: 2 }}>DURATION</p>
                <p style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 18, color: C }}>{formatTime(live.elapsedSecs)}</p>
              </div>
              <div>
                <p style={{ fontSize: 10, color: "hsl(187 100% 52% / 0.6)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.1em", marginBottom: 2 }}>CREDITS USED</p>
                <p style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 18, color: C }}>{live.credits.toLocaleString()}</p>
              </div>
              <div>
                <p style={{ fontSize: 10, color: "hsl(187 100% 52% / 0.6)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.1em", marginBottom: 2 }}>COST THIS SESSION</p>
                <p style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 18, color: C }}>${live.usd.toFixed(2)}</p>
              </div>
              <div>
                <p style={{ fontSize: 10, color: "hsl(187 100% 52% / 0.6)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.1em", marginBottom: 2 }}>RATE</p>
                <p style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 18, color: C }}>2 cr/s</p>
              </div>
            </div>
          </div>
        )}

        {/* All-time summary cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginBottom: 28 }}>
          <StatCard icon={Activity}     label="Total Sessions"  value={history.length.toString()} sub="all time" />
          <StatCard icon={Clock}        label="Total Time"      value={formatTime(totalSecs)}      sub="streamed" />
          <StatCard icon={Zap}          label="Total Credits"   value={totalCredits.toLocaleString()} sub="@ 2 cr/s" color={C} glow={totalCredits > 0} />
          <StatCard icon={DollarSign}   label="Total Spent"     value={`$${totalUsd.toFixed(2)}`}  sub="@ $0.01/credit" color="hsl(143 72% 50%)" glow={totalUsd > 0} />
        </div>

        {/* Session history */}
        <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, overflow: "hidden" }}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid hsl(222 40% 11%)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <TrendingUp style={{ width: 14, height: 14, color: C }} />
              <span style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 11, letterSpacing: "0.1em", color: "hsl(190 80% 96%)" }}>SESSION HISTORY</span>
              {history.length > 0 && (
                <span style={{ padding: "2px 8px", borderRadius: 20, background: "hsl(187 100% 52% / 0.12)", border: "1px solid hsl(187 100% 52% / 0.25)", fontSize: 10, color: C, fontFamily: "'Orbitron',monospace", fontWeight: 700 }}>
                  {history.length}
                </span>
              )}
            </div>
            {history.length > 0 && (
              <button onClick={handleClear} style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "5px 12px", borderRadius: 7,
                background: "hsl(0 85% 40% / 0.15)", border: "1px solid hsl(0 85% 40% / 0.3)",
                color: "hsl(0 85% 65%)", cursor: "pointer",
                fontSize: 11, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif",
                transition: "all 0.2s",
              }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.3)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.15)"; }}
              >
                <Trash2 style={{ width: 11, height: 11 }} /> Clear
              </button>
            )}
          </div>

          {history.length === 0 ? (
            <div style={{ padding: "48px 20px", textAlign: "center" }}>
              <div style={{ width: 52, height: 52, borderRadius: "50%", background: "hsl(222 40% 9%)", border: "1px solid hsl(222 40% 14%)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
                <Activity style={{ width: 22, height: 22, color: "hsl(222 25% 35%)" }} />
              </div>
              <p style={{ fontFamily: "'Orbitron',monospace", fontSize: 13, fontWeight: 700, color: "hsl(222 25% 45%)", marginBottom: 6 }}>No sessions yet</p>
              <p style={{ fontSize: 13, color: "hsl(222 25% 35%)", fontFamily: "'Rajdhani',sans-serif" }}>Your streaming history will appear here after your first session</p>
            </div>
          ) : (
            <div>
              {/* Table header */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 110px 100px 100px", gap: 0, padding: "10px 20px", borderBottom: "1px solid hsl(222 40% 9%)" }}>
                {["Date / Time", "Duration", "Credits", "Cost", "Rate"].map(h => (
                  <span key={h} style={{ fontSize: 9, fontWeight: 700, color: "hsl(222 25% 38%)", textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace" }}>{h}</span>
                ))}
              </div>

              {/* Rows */}
              <div style={{ maxHeight: 400, overflowY: "auto" }}>
                {history.map((s, i) => (
                  <div key={s.id} style={{
                    display: "grid", gridTemplateColumns: "1fr 110px 110px 100px 100px",
                    gap: 0, padding: "12px 20px",
                    borderBottom: i < history.length - 1 ? "1px solid hsl(222 40% 8%)" : "none",
                    background: i % 2 === 0 ? "transparent" : "hsl(222 47% 4% / 0.5)",
                    transition: "background 0.15s",
                  }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "hsl(187 100% 52% / 0.04)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = i % 2 === 0 ? "transparent" : "hsl(222 47% 4% / 0.5)"; }}
                  >
                    <div>
                      <p style={{ fontSize: 13, color: "hsl(190 80% 90%)", fontFamily: "'Rajdhani',sans-serif", fontWeight: 600 }}>{formatDate(s.startedAt)}</p>
                      <p style={{ fontSize: 10, color: "hsl(222 25% 40%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 2 }}>ended {formatDate(s.endedAt)}</p>
                    </div>
                    <span style={{ fontSize: 13, color: "hsl(190 80% 85%)", fontFamily: "'Orbitron',monospace", fontWeight: 600, alignSelf: "center" }}>{formatTime(s.durationSecs)}</span>
                    <span style={{ fontSize: 13, color: C, fontFamily: "'Orbitron',monospace", fontWeight: 700, alignSelf: "center" }}>{s.credits.toLocaleString()}</span>
                    <span style={{ fontSize: 13, color: "hsl(143 72% 55%)", fontFamily: "'Orbitron',monospace", fontWeight: 700, alignSelf: "center" }}>${s.usd.toFixed(2)}</span>
                    <span style={{ fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", alignSelf: "center" }}>2 cr/s</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {history.length > 0 && (
          <p style={{ marginTop: 12, fontSize: 11, color: "hsl(222 25% 35%)", fontFamily: "'Rajdhani',sans-serif", textAlign: "right" }}>
            Showing {history.length} session{history.length !== 1 ? "s" : ""} · stored locally on this device
          </p>
        )}
      </div>

      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}`}</style>
    </AppLayout>
  );
}
