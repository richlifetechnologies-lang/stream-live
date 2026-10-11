import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { AppLayout } from "../components/layout";
import { ContactCard, PayCard, hasContact, hasPayment } from "../components/contact";
import { gateway, useAccount } from "../lib/gateway";
import { MOD_LABELS } from "../lib/minutes";
import { FEATURE_LABELS, usd, type AccountSnapshot, type Modality, type Plan } from "@stream-live/client";
import { Check, Clock, Monitor, RefreshCw, Sparkles, Tag } from "lucide-react";

const C = "hsl(187 100% 52%)";
const MODS: Modality[] = ["video", "audio", "video_audio"];

const panel: React.CSSProperties = {
  background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 18, marginBottom: 14,
};
const head: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em",
  fontFamily: "'Orbitron', monospace", marginBottom: 14,
};

export default function PlansPage() {
  const account = useAccount();
  const [, setLocation] = useLocation();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [snap, setSnap] = useState<AccountSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!account.signedIn) return;
    try {
      const [p, s] = await Promise.all([gateway.plans(), gateway.snapshot()]);
      setPlans(p); setSnap(s); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [account.signedIn]);

  useEffect(() => { void load(); }, [load]);

  if (!account.signedIn) {
    return (
      <AppLayout>
        <div style={{ padding: "28px 32px", maxWidth: 620, margin: "0 auto", textAlign: "center" }}>
          <h1 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 20, color: "hsl(190 80% 96%)", marginBottom: 8 }}>Plans and prices</h1>
          <p style={{ color: "hsl(222 25% 55%)", fontSize: 13.5, fontFamily: "'Rajdhani',sans-serif", marginBottom: 18 }}>
            Sign in to see the packages your administrator sells and how to reach them.
          </p>
          <button onClick={() => setLocation("/account")}
            style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: C, color: "hsl(222 47% 4%)", fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani',sans-serif", cursor: "pointer" }}>
            Sign in
          </button>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div style={{ padding: "28px 32px", maxWidth: 980, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 20, color: "hsl(190 80% 96%)", marginBottom: 3 }}>Plans and prices</h1>
            <p style={{ fontSize: 13, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", maxWidth: 620, margin: 0 }}>
              The packages your administrator sells and the minutes each one carries. Pay by MoMo or Bitcoin, then ask for the top-up on the Minutes page — minutes never expire.
            </p>
          </div>
          <button onClick={() => void load()}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, background: "hsl(187 100% 52% / 0.12)", border: `1px solid ${C}44`, cursor: "pointer", color: C, fontSize: 12, fontWeight: 700, fontFamily: "'Orbitron',monospace" }}>
            <RefreshCw style={{ width: 12, height: 12 }} /> Refresh
          </button>
        </div>

        {error && (
          <div style={{ marginBottom: 14, padding: "11px 15px", borderRadius: 10, background: "hsl(0 85% 40% / 0.12)", border: "1px solid hsl(0 85% 40% / 0.3)", color: "hsl(0 85% 70%)", fontSize: 13, fontFamily: "'Rajdhani',sans-serif" }}>
            {error}
          </div>
        )}

        {loaded && plans.length === 0 && !error && (
          <div style={panel}>
            <p style={{ fontSize: 13, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>
              No packages are listed yet. Ask your administrator what minutes are available.
            </p>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 16 }}>
          {plans.map(p => {
            const mine = snap?.planId === p.id;
            const mins = MODS.filter(m => p.minutes[m] > 0);
            return (
              <div key={p.id} style={{ ...panel, marginBottom: 0, borderColor: mine ? `${C}66` : "hsl(222 40% 11%)", display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                  <p style={{ ...head, marginBottom: 2 }}>{p.name}</p>
                  {mine && <span style={{ fontSize: 9.5, fontWeight: 700, color: C, background: `${C}1a`, border: `1px solid ${C}44`, borderRadius: 999, padding: "3px 8px", fontFamily: "'Orbitron',monospace", whiteSpace: "nowrap" }}>YOUR PLAN</span>}
                </div>
                <p style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 30, lineHeight: 1.1, color: "hsl(190 80% 96%)", margin: "6px 0 2px" }}>
                  {usd(p.priceCents)}
                  <span style={{ fontSize: 12, fontWeight: 600, color: "hsl(222 25% 48%)", fontFamily: "'Rajdhani',sans-serif", marginLeft: 6 }}>USD</span>
                </p>
                {p.blurb && (
                  <p style={{ fontSize: 12.5, color: "hsl(222 25% 60%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5, margin: "4px 0 12px" }}>{p.blurb}</p>
                )}

                {mins.length > 0 && (
                  <div style={{ background: "hsl(187 100% 52% / 0.06)", border: "1px solid hsl(187 100% 52% / 0.2)", borderRadius: 10, padding: "10px 12px", marginTop: 10 }}>
                    <p style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", color: "hsl(222 25% 50%)", margin: "0 0 7px" }}>Minutes in this package</p>
                    {mins.map(m => (
                      <p key={m} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 12.5, fontFamily: "'Rajdhani',sans-serif", margin: "4px 0" }}>
                        <span style={{ color: "hsl(222 25% 68%)" }}>{MOD_LABELS[m]}</span>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 13, color: "hsl(190 80% 96%)", whiteSpace: "nowrap" }}>
                          <Clock style={{ width: 11, height: 11, color: C, flexShrink: 0 }} />
                          {p.minutes[m].toLocaleString("en-US")} min
                        </span>
                      </p>
                    ))}
                  </div>
                )}

                {p.includes.length > 0 && (
                  <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                    {p.includes.map((line, i) => (
                      <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, color: "hsl(190 80% 90%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.45 }}>
                        <Check style={{ width: 13, height: 13, color: C, flexShrink: 0, marginTop: 2 }} /> {line}
                      </li>
                    ))}
                  </ul>
                )}

                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: "auto", paddingTop: 12, borderTop: "1px solid hsl(222 40% 11%)" }}>
                  {p.features.map(f => (
                    <span key={f} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999, fontSize: 10.5, fontWeight: 700, color: "hsl(187 100% 72%)", background: "hsl(187 100% 52% / 0.1)", border: "1px solid hsl(187 100% 52% / 0.24)", fontFamily: "'Rajdhani',sans-serif" }}>
                      <Sparkles style={{ width: 10, height: 10 }} /> {FEATURE_LABELS[f] ?? f}
                    </span>
                  ))}
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999, fontSize: 10.5, fontWeight: 700, color: "hsl(222 25% 62%)", background: "hsl(222 40% 10%)", border: "1px solid hsl(222 40% 16%)", fontFamily: "'Rajdhani',sans-serif" }}>
                    <Monitor style={{ width: 10, height: 10 }} /> {p.maxDevices === 1 ? "1 device" : `${p.maxDevices} devices`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {snap && (hasPayment(snap.pay) || hasContact(snap.contact)) ? (
          <>
            <PayCard pay={snap.pay} title="Pay the administrator — MoMo or Bitcoin only" />
            <ContactCard contact={snap.contact} title="After paying, tell the administrator" />
          </>
        ) : (
            <div style={{ ...panel, borderColor: "hsl(35 100% 55% / 0.32)" }}>
              <p style={{ ...head, color: "hsl(35 100% 62%)" }}><Tag style={{ width: 11, height: 11, verticalAlign: -1, marginRight: 6 }} />No payment details yet</p>
              <p style={{ fontSize: 13, color: "hsl(222 25% 60%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>
                Your administrator has not published a MoMo number, Bitcoin address or contact handle yet. Send a request from the{" "}
                <button onClick={() => setLocation("/minutes")} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: C, fontSize: 13, fontFamily: "'Rajdhani',sans-serif", textDecoration: "underline" }}>Minutes page</button>{" "}
                and they will see it in their panel.
              </p>
            </div>
          )}

        <div style={{ ...panel, background: "transparent", border: "1px dashed hsl(222 40% 14%)" }}>
          <p style={{ fontSize: 12, color: "hsl(222 25% 48%)", fontFamily: "'Rajdhani',sans-serif", margin: 0, lineHeight: 1.6 }}>
            The minutes above land in your account when your administrator confirms the payment, and they never expire. Prices and minutes are set by them — Stream Live takes no card details, charges nothing inside the app, and there is no trial balance.
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
