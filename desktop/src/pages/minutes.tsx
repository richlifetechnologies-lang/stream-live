import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { AppLayout } from "../components/layout";
import { countdown, drainOf, MOD_LABELS, type LiveLease } from "../lib/minutes";
import { useTicker } from "../components/meter";
import { ContactCard, PayCard } from "../components/contact";
import { WatermarkOffer } from "../components/watermark-offer";
import { gateway, useAccount, useLease, requestTopup } from "../lib/gateway";
import { toUserMessage } from "../lib/end-reason";
import { FEATURE_LABELS, usd, type AccountSnapshot, type CheckoutInfo, type Modality, type Plan } from "@stream-live/client";
import { Hourglass, Radio, RefreshCw, Send, ArrowLeftRight, CircleCheck, CircleOff, CreditCard, Check, Clock, Monitor, Sparkles } from "lucide-react";

const C = "hsl(187 100% 52%)";
const MODS: Modality[] = ["video", "audio", "video_audio"];

/** The cedi figure the payment page charges — the seller's own, not a guess. */
const ghs = (n: number) => "GH\u20B5" + n.toFixed(2);

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
  const [shop, setShop] = useState<CheckoutInfo | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
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
      const [s, pl, l, r] = await Promise.all([
        gateway.snapshot(), gateway.plans(), gateway.ledger(12), gateway.myRequests(),
      ]);
      setSnap(s); setPlans(pl); setLedger(l); setRequests(r); setError(null);
    } catch (e) {
      setError(toUserMessage(e, "We couldn't load your minutes. Try again in a moment."));
    } finally {
      setLoaded(true);
    }
  }, [account.signedIn]);

  useEffect(() => { void load(); }, [load]);
  // The packages change far less often than the balances, so this is read once per
  // visit rather than on every 15-second refresh.
  useEffect(() => {
    if (!account.signedIn) return;
    let alive = true;
    gateway.checkout().then(c => { if (alive && c) setShop(c); });
    return () => { alive = false; };
  }, [account.signedIn]);
  // Balances move when a lease settles, so refresh while the page is open.
  useEffect(() => {
    if (!account.signedIn) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000);
    return () => clearInterval(id);
  }, [account.signedIn, load]);

  const askFor = (modality: Modality) => {
    setReqModality(modality);
    showAskForm();
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
      setError(toUserMessage(err, "Could not send the request. Try again."));
    } finally { setSending(false); }
  };

  if (!account.signedIn) {
    return (
      <AppLayout>
        <div style={{ padding: "28px 32px", maxWidth: 620, margin: "0 auto", textAlign: "center" }}>
          <h1 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 20, color: "hsl(190 80% 96%)", marginBottom: 8 }}>Buy minutes</h1>
          <p style={{ color: "hsl(222 25% 55%)", fontSize: 13.5, fontFamily: "'Rajdhani',sans-serif", marginBottom: 18 }}>
            Sign in to see the packages on sale and what is left in each of your buckets.
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
  const videoBurn = Number(snap?.wallets.find(w => w.modality === "video")?.burn_rate) || 1;
  const videoLeft = snap ? bucketRemaining("video", snap, live, videoBurn, now) : null;
  // Only a package the payment service itself quotes is buyable. A card it does not
  // name keeps its price and its minutes and simply has no button, so this screen can
  // never promise a purchase the page would refuse.
  const online = shop?.enabled === true;
  const goToPackages = () =>
    document.getElementById("packages")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const showAskForm = () =>
    document.getElementById("askForm")?.scrollIntoView({ behavior: "smooth", block: "center" });

  return (
    <AppLayout>
      <div style={{ padding: "28px 32px", maxWidth: 860, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 20, color: "hsl(190 80% 96%)", marginBottom: 3 }}>Buy minutes</h1>
            <p style={{ fontSize: 13, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif" }}>
              {account.email}{running > 0 ? ` · ${running} call${running === 1 ? "" : "s"} running` : ""}
            </p>
          </div>
          <button onClick={() => void load()}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, background: "hsl(187 100% 52% / 0.12)", border: `1px solid ${C}44`, cursor: "pointer", color: C, fontSize: 12, fontWeight: 700, fontFamily: "'Orbitron',monospace" }}>
            <RefreshCw style={{ width: 12, height: 12 }} /> Refresh
          </button>
        </div>

        {snap && (
          <WatermarkOffer
            paid={snap.paid}
            videoMinutesLeft={videoLeft}
            ctaLabel="Ask for minutes"
            ctaOnClick={showAskForm}
          />
        )}

        {error && (
          <div style={{ marginBottom: 14, padding: "11px 15px", borderRadius: 10, background: "hsl(0 85% 40% / 0.12)", border: "1px solid hsl(0 85% 40% / 0.3)", color: "hsl(0 85% 70%)", fontSize: 13, fontFamily: "'Rajdhani',sans-serif" }}>
            {error}
          </div>
        )}

        {/* Every package the administrator lists, in the order a buyer reads them. */}
        <div id="packages" style={{ marginBottom: 18 }}>
          <p style={head}>Choose a package</p>
          {loaded && plans.length === 0 && !error && (
            <div style={panel}>
              <p style={{ fontSize: 13, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>
                No packages are listed yet. Ask your administrator what minutes are available.
              </p>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
            {plans.map(p => {
              const mine = snap?.planId === p.id;
              const mins = MODS.filter(m => p.minutes[m] > 0);
              const buyable = online ? shop!.prices[p.id] : undefined;
              return (
                <div key={p.id} style={{ ...panel, marginBottom: 0, borderColor: mine ? `${C}66` : "hsl(222 40% 11%)", display: "flex", flexDirection: "column" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                    <p style={{ ...head, marginBottom: 2 }}>{p.name}</p>
                    {mine && <span style={{ fontSize: 9.5, fontWeight: 700, color: C, background: `${C}1a`, border: `1px solid ${C}44`, borderRadius: 999, padding: "3px 8px", fontFamily: "'Orbitron',monospace", whiteSpace: "nowrap" }}>YOUR PLAN</span>}
                  </div>
                  <p style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 30, lineHeight: 1.1, color: "hsl(190 80% 96%)", margin: "6px 0 2px" }}>
                    {buyable !== undefined ? ghs(buyable) : p.priceCents > 0 ? usd(p.priceCents) : "No price set"}
                    {buyable !== undefined && (
                      <span style={{ fontSize: 12, fontWeight: 600, color: "hsl(222 25% 48%)", fontFamily: "'Rajdhani',sans-serif", marginLeft: 6 }}>GHS</span>
                    )}
                  </p>
                  {buyable !== undefined && p.priceCents > 0 && (
                    <p style={{ fontSize: 11, color: "hsl(222 25% 42%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>
                      the {usd(p.priceCents)} price, charged in cedis
                    </p>
                  )}
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

                  {buyable !== undefined ? (
                    <a href={shop!.page} target="_blank" rel="noreferrer"
                      style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 12, padding: "11px 16px", borderRadius: 10, background: C, color: "hsl(222 47% 4%)", fontWeight: 700, fontSize: 13.5, fontFamily: "'Rajdhani',sans-serif", textDecoration: "none", cursor: "pointer" }}>
                      <CreditCard style={{ width: 14, height: 14 }} /> Buy — {ghs(buyable)}
                    </a>
                  ) : online && (
                    <p style={{ marginTop: 12, padding: "9px 12px", borderRadius: 10, background: "hsl(35 100% 55% / 0.08)", border: "1px solid hsl(35 100% 55% / 0.3)", color: "hsl(35 100% 72%)", fontSize: 12, fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5, margin: "12px 0 0" }}>
                      This one cannot be paid for in the app yet. Ask your administrator and they will arrange it.
                    </p>
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
          <p style={{ fontSize: 11.5, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", margin: "10px 0 0", lineHeight: 1.6 }}>
            {online
              ? "The Buy button opens the payment page in your browser — card or mobile money — and the minutes are in your account the moment it clears. You do not need to send a request for anything bought that way. Minutes never expire."
              : "Pay your administrator directly, then send the request below. The minutes land in the bucket once they approve it, and they never expire."}
          </p>
        </div>

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
            {shop?.enabled === true && (
              <button onClick={goToPackages}
                style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 15px", borderRadius: 9, border: "none", background: C, color: "hsl(222 47% 4%)", fontWeight: 700, fontSize: 12.5, fontFamily: "'Rajdhani',sans-serif", cursor: "pointer" }}>
                <CreditCard style={{ width: 13, height: 13 }} /> Choose a package
              </button>
            )}
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
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 26, lineHeight: 1, color: tone, fontVariantNumeric: "tabular-nums", margin: 0 }}>
                    {w.unlimited ? "UNLIMITED" : countdown(remaining)}
                  </p>
                  <p style={{ fontSize: 10, color: "hsl(222 25% 42%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 4 }}>
                    min remaining
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
                {/* Only what the administrator has put in, never what a call took
                    out - the balance above is already the answer to that. */}
                <span style={{ fontSize: 10.5, color: "hsl(222 25% 40%)", fontFamily: "'Rajdhani',sans-serif", marginLeft: "auto" }}>
                  {Number(w.total_credited).toFixed(1)} min credited
                </span>
                {(zero || low) && (
                  shop?.enabled === true ? (
                    <button onClick={goToPackages}
                      style={{ padding: "6px 12px", borderRadius: 7, background: `${tone}1f`, border: `1px solid ${tone}55`, cursor: "pointer", color: tone, fontSize: 11, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif" }}>
                      Buy minutes
                    </button>
                  ) : (
                    <button onClick={() => askFor(w.modality)}
                      style={{ padding: "6px 12px", borderRadius: 7, background: `${tone}1f`, border: `1px solid ${tone}55`, cursor: "pointer", color: tone, fontSize: 11, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif" }}>
                      Ask for minutes
                    </button>
                  )
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
                      {s.device_id ?? "unknown device"}
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
              {shop?.enabled === true
                ? "Use this only when you paid outside the app — by MoMo, Bitcoin or in person. Anything bought with the Buy button above needs no request; the minutes arrive on their own."
                : "Nothing is charged inside the app. Pay your administrator directly, then send the request — the minutes land in this bucket once they approve it and never expire."}
            </p>
          </form>
        </div>

        {snap && (
          <>
            <PayCard pay={snap.pay} title="Pay your administrator — MoMo or Bitcoin only" />
            <ContactCard contact={snap.contact} title="Send the payment reference" />
          </>
        )}

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
