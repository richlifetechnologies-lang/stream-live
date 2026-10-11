import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { AppLayout } from "../components/layout";
import { countdown, drainOf, useTicker, MOD_LABELS } from "../components/meter";
import { gateway, useAccount, useLease, requestTopup, type LiveLease } from "../lib/gateway";
import type { AccountSnapshot, Modality } from "@stream-live/client";
import { Hourglass, Radio, RefreshCw, Send, ArrowLeftRight, CircleCheck, CircleOff } from "lucide-react";

const C = "hsl(187 100% 52%)";
const MODS: Modality[] = ["video", "audio", "video_audio"];

const TAB_TO_MODALITY: Record<string, Modality> = {
  "video-only": "video",
  "audio-only": "audio",
  "video-audio": "video_audio",
};

const panel: React.CSSProperties = {
  background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 18, marginBottom: 14,
};
const head: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em",
  fontFamily: "'Orbitron', monospace", marginBottom: 14,
};
const inputSt: React.CSSProperties = {
  width: "100%", padding: "9px 12px", background: "hsl(222 47% 4%)", border: "1px solid hsl(222 40% 14%)",
  borderRadius: 8, color: "hsl(190 80% 96%)", fontSize: 13, fontFamily: "'Rajdhani', sans-serif", outline: "none",
};
const labelSt: React.CSSProperties = {
  display: "block", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em",
  fontFamily: "'Orbitron', monospace", marginBottom: 6, color: "hsl(222 25% 50%)",
};

function fmtDate(ts: string | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** What a bucket holds right now: the gateway number, drained by this machine's lease. */
function bucketRemaining(modality: Modality, snap: AccountSnapshot, live: LiveLease | null, burnRate: number, now: number): number | null {
  if (live && live.modality === modality) return drainOf(live, burnRate, now).remaining;
  const w = snap.wallets.find(x => x.modality === modality);
  return w?.unlimited ? null : Number(w?.balance ?? 0);
}

export default function MinutesPage() {
  const account = useAccount();
  const live = useLease();
  const now = useTicker(1000);
  const [, setLocation] = useLocation();

  const [snap, setSnap] = useState<AccountSnapshot | null>(null);
  const [ledger, setLedger] = useState<Array<Record<string, unknown>>>([]);
  const [requests, setRequests] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [reqModality, setReqModality] = useState<Modality>("video_audio");
  const [reqMinutes, setReqMinutes] = useState("60");
  const [reqReference, setReqReference] = useState("");
  const [reqNote, setReqNote] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!account.signedIn) return;
    try {
      const [s, l, r] = await Promise.all([gateway.snapshot(), gateway.ledger(12), gateway.myRequests()]);
      setSnap(s); setLedger(l); setRequests(r); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [account.signedIn]);

  useEffect(() => { void load(); }, [load]);
  // Balances move when a lease settles, so refresh while the page is open.
  useEffect(() => {
    if (!account.signedIn) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000);
    return () => clearInterval(id);
  }, [account.signedIn, load]);

  const askFor = (modality: Modality) => {
    setReqModality(modality);
    document.getElementById("askForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending) return;
    const minutes = Number(reqMinutes);
    if (!(minutes > 0)) { setError("Say how many minutes you need."); return; }
    setSending(true);
    try {
      await requestTopup({ modality: reqModality, minutes, paymentReference: reqReference.trim() || undefined, note: reqNote.trim() || undefined });
      setReqReference(""); setReqNote(""); setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the request.");
    } finally { setSending(false); }
  };

  if (!account.signedIn) {
    return (
      <AppLayout>
        <div style={{ padding: "28px 32px", maxWidth: 620, margin: "0 auto", textAlign: "center" }}>
          <h1 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 20, color: "hsl(190 80% 96%)", marginBottom: 8 }}>Your minutes</h1>
          <p style={{ color: "hsl(222 25% 55%)", fontSize: 13.5, fontFamily: "'Rajdhani',sans-serif", marginBottom: 18 }}>
            Sign in to see what is left in each bucket and watch it drain while you are live.
          </p>
          <button onClick={() => setLocation("/account")}
            style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: C, color: "hsl(222 47% 4%)", fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani',sans-serif", cursor: "pointer" }}>
            Sign in
          </button>
        </div>
      </AppLayout>
    );
  }

  const totalUnlimited = snap?.wallets.some(w => w.unlimited) ?? false;
  const total = (snap?.wallets ?? []).reduce((sum, w) => {
    const r = bucketRemaining(w.modality, snap!, live, Number(w.burn_rate) || 1, now);
    return sum + (r ?? 0);
  }, 0);
  const running = snap?.openSessions.length ?? 0;
  const pending = requests.filter(r => r.status === "pending").length;

  return (
    <AppLayout>
      <div style={{ padding: "28px 32px", maxWidth: 860, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 20, color: "hsl(190 80% 96%)", marginBottom: 3 }}>Your minutes</h1>
            <p style={{ fontSize: 13, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif" }}>
              {account.email}{running > 0 ? ` · ${running} call${running === 1 ? "" : "s"} running` : ""}
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

        {/* Total across every bucket */}
        <div style={{ ...panel, display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
          <div>
            <p style={{ ...head, marginBottom: 6 }}>Total available now</p>
            <p style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 40, lineHeight: 1, color: C, fontVariantNumeric: "tabular-nums", margin: 0 }}>
              {totalUnlimited ? "UNLIMITED" : countdown(total)}
            </p>
            <p style={{ fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 6 }}>
              minutes:seconds across all three buckets · they never expire
            </p>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
            <Badge icon={Radio} tone={running > 0 ? "hsl(143 72% 55%)" : "hsl(222 25% 45%)"} text={running > 0 ? `${running} live now` : "no calls running"} />
            <Badge icon={Hourglass} tone={pending > 0 ? "hsl(35 100% 60%)" : "hsl(222 25% 45%)"} text={pending > 0 ? `${pending} top-up${pending === 1 ? "" : "s"} waiting` : "no requests waiting"} />
          </div>
        </div>

        {/* One card per bucket */}
        {snap?.wallets.map(w => {
          const burn = Number(w.burn_rate) || 1;
          const remaining = bucketRemaining(w.modality, snap, live, burn, now);
          const modLive = live?.modality === w.modality ? drainOf(live, burn, now) : null;
          const otherCall = snap.openSessions.some(s => TAB_TO_MODALITY[s.tab] === w.modality);
          const allowed = snap.modalities[w.modality];
          const zero = !w.unlimited && (remaining ?? 0) < 1;
          const low = !w.unlimited && !zero && (remaining ?? 0) < 5;
          const tone = zero || !allowed ? "hsl(0 85% 62%)" : low ? "hsl(35 100% 60%)" : C;
          return (
            <div key={w.modality} style={{ ...panel, borderColor: modLive ? `${C}55` : "hsl(222 40% 11%)", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 190px", minWidth: 0 }}>
                  <p style={{ ...head, marginBottom: 4, color: tone }}>{MOD_LABELS[w.modality]}</p>
                  <p style={{ fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>
                    1 real minute = {burn} credit minute{burn === 1 ? "" : "s"}
                  </p>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 26, lineHeight: 1, color: tone, fontVariantNumeric: "tabular-nums", margin: 0 }}>
                    {w.unlimited ? "UNLIMITED" : countdown(remaining)}
                  </p>
                  <p style={{ fontSize: 10, color: "hsl(222 25% 42%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 4 }}>
                    {modLive ? `this call ${countdown(modLive.used)} · ${Math.round(modLive.live)} min on air` : "min remaining"}
                  </p>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
                {allowed
                  ? <Badge icon={CircleCheck} tone="hsl(143 72% 55%)" text="this account may use it" />
                  : <Badge icon={CircleOff} tone="hsl(0 85% 62%)" text="switched off by your administrator" />}
                {(modLive || otherCall) && (
                  <Badge icon={Radio} tone={C} text={modLive ? "draining on this device" : "in use on another device"} />
                )}
                <span style={{ fontSize: 10.5, color: "hsl(222 25% 40%)", fontFamily: "'Rajdhani',sans-serif", marginLeft: "auto" }}>
                  {Number(w.total_credited).toFixed(0)} credited · {Number(w.total_spent).toFixed(1)} spent
                </span>
                {(zero || low) && (
                  <button onClick={() => askFor(w.modality)}
                    style={{ padding: "6px 12px", borderRadius: 7, background: `${tone}1f`, border: `1px solid ${tone}55`, cursor: "pointer", color: tone, fontSize: 11, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif" }}>
                    Ask for minutes
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* Calls running right now */}
        <div style={{ ...panel, marginTop: 16 }}>
          <p style={head}>Calls running now</p>
          {running === 0 ? (
            <p style={{ fontSize: 13, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>
              Nothing is metered at the moment. Minutes only leave your bucket while a call is open.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {snap!.openSessions.map(s => (
                <div key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "9px 13px", background: "hsl(222 40% 8%)", borderRadius: 8, border: "1px solid hsl(222 40% 12%)" }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 12, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>
                      {MOD_LABELS[TAB_TO_MODALITY[s.tab] ?? "video_audio"]}
                      <span style={{ color: "hsl(222 25% 45%)", fontWeight: 400 }}> · started {fmtDate(s.started_at)}</span>
                    </p>
                    <p style={{ fontSize: 10, color: "hsl(222 25% 40%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 2 }}>
                      {Math.max(0, Math.round((now - new Date(s.started_at).getTime()) / 60000))} min on air · billed {Number(s.real_minutes).toFixed(2)} min at last settle · {s.device_id ?? "unknown device"}
                    </p>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, color: C, fontFamily: "'Orbitron',monospace", whiteSpace: "nowrap" }}>
                    lease {leaseState(s.lease_expires_at, now)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Ask for minutes */}
        <div id="askForm" style={panel}>
          <p style={head}>Ask your administrator for minutes</p>
          <form onSubmit={handleAsk} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.3fr 0.7fr", gap: 12 }}>
              <div>
                <label style={labelSt}>Bucket</label>
                <select value={reqModality} onChange={e => setReqModality(e.target.value as Modality)} style={inputSt}>
                  {MODS.map(m => <option key={m} value={m}>{MOD_LABELS[m]}</option>)}
                </select>
              </div>
              <div>
                <label style={labelSt}>Minutes</label>
                <input type="number" min={1} step={1} required value={reqMinutes} onChange={e => setReqMinutes(e.target.value)} style={inputSt} />
              </div>
            </div>
            <div>
              <label style={labelSt}>Payment reference</label>
              <input value={reqReference} onChange={e => setReqReference(e.target.value)} placeholder="What your administrator should match the payment to" style={inputSt} />
            </div>
            <div>
              <label style={labelSt}>Note</label>
              <textarea value={reqNote} onChange={e => setReqNote(e.target.value)} rows={2} placeholder="Anything else they should know" style={{ ...inputSt, resize: "vertical" }} />
            </div>
            <button type="submit" disabled={sending}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 18px", borderRadius: 8, border: "none", background: sending ? "hsl(222 40% 11%)" : C, color: sending ? "hsl(222 25% 35%)" : "hsl(222 47% 4%)", fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani',sans-serif", cursor: sending ? "not-allowed" : "pointer", width: "fit-content" }}>
              <Send style={{ width: 14, height: 14 }} /> {sending ? "Sending…" : "Send request"}
            </button>
            <p style={{ fontSize: 11, color: "hsl(222 25% 42%)", fontFamily: "'Rajdhani',sans-serif", margin: 0, lineHeight: 1.5 }}>
              Nothing is charged inside the app. Pay your administrator directly, then send the request — the minutes land in this bucket once they approve it and never expire.
            </p>
          </form>
        </div>

        {/* Requests + recent movements */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
          <div style={{ ...panel, marginBottom: 0 }}>
            <p style={head}>Your requests</p>
            {requests.length === 0 ? (
              <p style={{ fontSize: 13, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>Nothing asked for yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {requests.map(r => (
                  <div key={String(r.id)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 12px", background: "hsl(222 40% 8%)", borderRadius: 8, border: "1px solid hsl(222 40% 12%)" }}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: 12, color: "hsl(190 80% 92%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>{Number(r.minutes)} min · {MOD_LABELS[r.modality as Modality] ?? String(r.modality)}</p>
                      <p style={{ fontSize: 10, color: "hsl(222 25% 40%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 2 }}>{fmtDate(r.created_at as string)}{r.admin_note ? ` — ${String(r.admin_note)}` : ""}</p>
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: r.status === "approved" ? "hsl(143 72% 55%)" : r.status === "rejected" ? "hsl(0 85% 65%)" : "hsl(35 100% 65%)", fontFamily: "'Orbitron',monospace" }}>{String(r.status)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ ...panel, marginBottom: 0 }}>
            <p style={head}><ArrowLeftRight style={{ width: 11, height: 11, verticalAlign: -1, marginRight: 6 }} />Recent movements</p>
            {ledger.length === 0 ? (
              <p style={{ fontSize: 13, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>No credits or debits recorded yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {ledger.map((l, i) => {
                  const delta = Number(l.delta);
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "7px 12px", background: "hsl(222 40% 8%)", borderRadius: 7 }}>
                      <span style={{ fontSize: 11.5, color: "hsl(222 25% 60%)", fontFamily: "'Rajdhani',sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {MOD_LABELS[l.modality as Modality] ?? String(l.modality)} · {String(l.reason ?? l.kind)}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: delta > 0 ? "hsl(143 72% 55%)" : "hsl(0 75% 62%)", fontFamily: "'Orbitron',monospace", whiteSpace: "nowrap" }}>
                        {delta > 0 ? "+" : ""}{delta.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <button onClick={() => setLocation("/usage")}
              style={{ marginTop: 10, background: "none", border: "none", cursor: "pointer", padding: 0, color: C, fontSize: 11, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", textDecoration: "underline" }}>
              Full history →
            </button>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function Badge({ icon: Icon, tone, text }: { icon: React.ElementType; tone: string; text: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 999, fontSize: 10, fontWeight: 700, color: tone, background: `${tone}1a`, border: `1px solid ${tone}44`, fontFamily: "'Rajdhani',sans-serif" }}>
      <Icon style={{ width: 11, height: 11 }} /> {text}
    </span>
  );
}

function leaseState(expiresAt: string | null, now: number): string {
  if (!expiresAt) return "renewing";
  const secs = Math.round((new Date(expiresAt).getTime() - now) / 1000);
  return secs > 0 ? `${secs}s` : "expired";
}
