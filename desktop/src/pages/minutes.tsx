import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { AppLayout } from "../components/layout"
import { Stage, PageHead, Card, CardTitle, Stat, PrimaryButton, D2 } from "../components/d2";
import { countdown, drainOf, MOD_LABELS, type LiveLease } from "../lib/minutes";
import { useTicker } from "../components/meter";
import { ContactCard, PayCard } from "../components/contact";
import { WatermarkOffer } from "../components/watermark-offer";
import { gateway, useAccount, useLease, requestTopup } from "../lib/gateway";
import { toUserMessage } from "../lib/end-reason";
import { t } from "../lib/i18n";
import type { AccountSnapshot, CheckoutInfo, Modality } from "@stream-live/client";
import { payBucket } from "@stream-live/client";
import { Hourglass, Radio, RefreshCw, Send, ArrowLeftRight, CircleCheck, CircleOff, CreditCard } from "lucide-react";

const MODS: Modality[] = ["video", "audio"];

const TAB_TO_MODALITY: Record<string, Modality> = {
  "video-only": "video",
  "audio-only": "audio",
  "video-audio": "video_audio",
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
  const liveHere = leaseOn(live, modality);
  if (liveHere) return drainOf(liveHere, rateOf(snap, liveHere, burnRate), now).remaining;
  const w = snap.wallets.find(x => x.modality === modality);
  return w?.unlimited ? null : Number(w?.balance ?? 0);
}

/**
 * One pool: a Video + Audio call spends from the video bucket, so a lease counts against that
 * row whichever tab opened it — and at the rate the administrator set for the call type, not
 * the rate written on the bucket it happens to share.
 */
function leaseOn(live: LiveLease | null, modality: Modality): LiveLease | null {
  return live && payBucket(live.modality) === modality ? live : null;
}

function rateOf(snap: AccountSnapshot, live: LiveLease, fallback: number): number {
  return Number(snap.rates[live.modality]) || fallback;
}

export default function MinutesPage() {
  const account = useAccount();
  const live = useLease();
  const now = useTicker(1000);
  const [, setLocation] = useLocation();

  const [snap, setSnap] = useState<AccountSnapshot | null>(null);
  const [shop, setShop] = useState<CheckoutInfo | null>(null);
  const [ledger, setLedger] = useState<Array<Record<string, unknown>>>([]);
  const [requests, setRequests] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [reqModality, setReqModality] = useState<Modality>("video");
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
      setError(toUserMessage(e, t("We couldn't load your minutes. Try again in a moment.")));
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
    document.getElementById("askForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending) return;
    const minutes = Number(reqMinutes);
    if (!(minutes > 0)) { setError(t("Say how many minutes you need.")); return; }
    setSending(true);
    try {
      await requestTopup({ modality: reqModality, minutes, paymentReference: reqReference.trim() || undefined, note: reqNote.trim() || undefined });
      setReqReference(""); setReqNote(""); setError(null);
      await load();
    } catch (err) {
      setError(toUserMessage(err, t("Could not send the request. Try again.")));
    } finally { setSending(false); }
  };

  if (!account.signedIn) {
    return (
      <AppLayout>
        <Stage>
          <PageHead name="Your minutes" note="Sign in to see what is left and watch it drain while you are live." />
          <Card style={{ maxWidth: 620, margin: "0 auto", textAlign: "center" }} pad={28}>
            <PrimaryButton onClick={() => setLocation("/account")} style={{ margin: "0 auto" }}>
              {t("Sign in")}
            </PrimaryButton>
          </Card>
        </Stage>
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

  return (
    <AppLayout>
      <Stage>
      <div style={{ padding: "0 0 40px", maxWidth: 860, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <PageHead
          name="Your minutes"
          pills={
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
              <span style={{ fontSize: 13, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif" }}>
                {account.email}{running > 0 ? ` · ${running === 1 ? t("{n} call running", { n: running }) : t("{n} calls running", { n: running })}` : ""}
              </span>
              <button onClick={() => void load()}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, background: "hsl(187 100% 52% / 0.12)", border: `1px solid ${D2}44`, cursor: "pointer", color: D2, fontSize: 12, fontWeight: 700, fontFamily: "'Orbitron',monospace" }}>
                <RefreshCw style={{ width: 12, height: 12 }} /> {t("Refresh")}
              </button>
            </div>
          }
          card={
            <Card pad={16}>
              <CardTitle>{t("Total available now")}</CardTitle>
              <p style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 34, lineHeight: 1, color: D2, fontVariantNumeric: "tabular-nums", margin: 0 }}>
                {totalUnlimited ? t("UNLIMITED") : countdown(total)}
              </p>
              <p style={{ fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 6 }}>
                {t("minutes left in your account · they never expire")}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start", marginTop: 12 }}>
                <Badge icon={Radio} tone={running > 0 ? "hsl(143 72% 55%)" : "hsl(222 25% 45%)"} text={running > 0 ? t("{n} live now", { n: running }) : t("no calls running")} />
                <Badge icon={Hourglass} tone={pending > 0 ? "hsl(35 100% 60%)" : "hsl(222 25% 45%)"} text={pending > 0 ? (pending === 1 ? t("{n} top-up waiting", { n: pending }) : t("{n} top-ups waiting", { n: pending })) : t("no requests waiting")} />
                {shop?.enabled === true && (
                  <button onClick={() => setLocation("/plans")}
                    style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 15px", borderRadius: 9, border: "none", background: D2, color: "hsl(222 47% 4%)", fontWeight: 700, fontSize: 12.5, fontFamily: "'Rajdhani',sans-serif", cursor: "pointer" }}>
                    <CreditCard style={{ width: 13, height: 13 }} /> {t("Buy minutes")}
                  </button>
                )}
              </div>
            </Card>
          }
        />

        {snap && <WatermarkOffer paid={snap.paid} videoMinutesLeft={videoLeft} />}

        {error && (
          <div style={{ marginBottom: 14, padding: "11px 15px", borderRadius: 10, background: "hsl(0 85% 40% / 0.12)", border: "1px solid hsl(0 85% 40% / 0.3)", color: "hsl(0 85% 70%)", fontSize: 13, fontFamily: "'Rajdhani',sans-serif" }}>
            {error}
          </div>
        )}

        {/* One card per bucket */}
        {snap?.wallets.map(w => {
          const burn = Number(w.burn_rate) || 1;
          const remaining = bucketRemaining(w.modality, snap, live, burn, now);
          const liveHere = leaseOn(live, w.modality);
          const modLive = liveHere ? drainOf(liveHere, rateOf(snap, liveHere, burn), now) : null;
          const otherCall = snap.openSessions.some(s => payBucket(TAB_TO_MODALITY[s.tab] ?? "video") === w.modality);
          const allowed = snap.modalities[w.modality];
          const zero = !w.unlimited && (remaining ?? 0) < 1;
          const low = !w.unlimited && !zero && (remaining ?? 0) < 5;
          const tone = zero || !allowed ? "hsl(0 85% 62%)" : low ? "hsl(35 100% 60%)" : D2;
          return (
            <Card key={w.modality} accent={tone} style={{ borderColor: modLive ? `${D2}55` : "hsl(222 40% 11%)" }}>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <CardTitle accent={tone}>{t(MOD_LABELS[w.modality])}</CardTitle>
                <div style={{ textAlign: "right" }}>
                  <Stat label="min remaining" value={w.unlimited ? t("UNLIMITED") : countdown(remaining)} accent={tone} />
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
                {allowed
                  ? <Badge icon={CircleCheck} tone="hsl(143 72% 55%)" text={t("this account may use it")} />
                  : <Badge icon={CircleOff} tone="hsl(0 85% 62%)" text={t("switched off by your administrator")} />}
                {(modLive || otherCall) && (
                  <Badge icon={Radio} tone={D2} text={modLive ? t("draining on this device") : t("in use on another device")} />
                )}
                {w.modality === "video" && (
                  <span style={{ flexBasis: "100%", fontSize: 10.5, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.45 }}>
                    {t("All three call tabs — Video Call, Video + Audio and Voice Clone Only — spend from these minutes. The two tabs that clone your voice run down faster, because a cloned voice costs more to run.")}
                  </span>
                )}
                {/* Only what the administrator has put in, never what a call took
                    out - the balance above is already the answer to that. */}
                <span style={{ fontSize: 10.5, color: "hsl(222 25% 40%)", fontFamily: "'Rajdhani',sans-serif", marginLeft: "auto" }}>
                  {t("{n} min credited", { n: Number(w.total_credited).toFixed(1) })}
                </span>
                {(zero || low) && (
                  shop?.enabled === true ? (
                    <button onClick={() => setLocation("/plans")}
                      style={{ padding: "6px 12px", borderRadius: 7, background: `${tone}1f`, border: `1px solid ${tone}55`, cursor: "pointer", color: tone, fontSize: 11, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif" }}>
                      {t("Buy minutes")}
                    </button>
                  ) : (
                    <button onClick={() => askFor(w.modality)}
                      style={{ padding: "6px 12px", borderRadius: 7, background: `${tone}1f`, border: `1px solid ${tone}55`, cursor: "pointer", color: tone, fontSize: 11, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif" }}>
                      {t("Ask for minutes")}
                    </button>
                  )
                )}
              </div>
            </Card>
          );
        })}

        {/* Calls running right now */}
        <Card>
          <CardTitle>{t("Calls running now")}</CardTitle>
          {running === 0 ? (
            <p style={{ fontSize: 13, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>
              {t("Nothing is metered at the moment. Minutes only leave your account while a call is open.")}
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {snap!.openSessions.map(s => (
                <div key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "9px 13px", background: "hsl(222 40% 8%)", borderRadius: 8, border: "1px solid hsl(222 40% 12%)" }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 12, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>
                      {t(MOD_LABELS[TAB_TO_MODALITY[s.tab] ?? "video_audio"])}
                      <span style={{ color: "hsl(222 25% 45%)", fontWeight: 400 }}> {t("· started {date}", { date: fmtDate(s.started_at) })}</span>
                    </p>
                    <p style={{ fontSize: 10, color: "hsl(222 25% 40%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 2 }}>
                      {s.device_id ?? t("unknown device")}
                    </p>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, color: D2, fontFamily: "'Orbitron',monospace", whiteSpace: "nowrap" }}>
                    {t("lease {state}", { state: leaseState(s.lease_expires_at, now) })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Ask for minutes */}
        <div id="askForm">
          <Card>
            <CardTitle>{t("Ask your administrator for minutes")}</CardTitle>
            <form onSubmit={handleAsk} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.3fr 0.7fr", gap: 12 }}>
                <div>
                  <label style={labelSt}>{t("Call type")}</label>
                  <select value={reqModality} onChange={e => setReqModality(e.target.value as Modality)} style={inputSt}>
                    {MODS.map(m => <option key={m} value={m}>{t(MOD_LABELS[m])}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelSt}>{t("Minutes")}</label>
                  <input type="number" min={1} step={1} required value={reqMinutes} onChange={e => setReqMinutes(e.target.value)} style={inputSt} />
                </div>
              </div>
              <div>
                <label style={labelSt}>{t("Payment reference")}</label>
                <input value={reqReference} onChange={e => setReqReference(e.target.value)} placeholder={t("What your administrator should match the payment to")} style={inputSt} />
              </div>
              <div>
                <label style={labelSt}>{t("Note")}</label>
                <textarea value={reqNote} onChange={e => setReqNote(e.target.value)} rows={2} placeholder={t("Anything else they should know")} style={{ ...inputSt, resize: "vertical" }} />
              </div>
              {/* The button keeps its native form-submit type inside the form, so the form's
                  validation and handleAsk still run; onClick is a no-op on purpose. */}
              <PrimaryButton onClick={() => undefined} disabled={sending} style={{ width: "fit-content" }}>
                <Send style={{ width: 14, height: 14 }} /> {sending ? t("Sending…") : t("Send request")}
              </PrimaryButton>
              <p style={{ fontSize: 11, color: "hsl(222 25% 42%)", fontFamily: "'Rajdhani',sans-serif", margin: 0, lineHeight: 1.5 }}>
                {shop?.enabled === true
                  ? t("Use this only when you paid outside the app — by MoMo, Bitcoin or in person. Anything bought with the Buy button needs no request; the minutes arrive on their own.")
                  : t("Nothing is charged inside the app. Pay your administrator directly, then send the request — the minutes land in your account once they approve it and never expire.")}{" "}
                <button onClick={() => setLocation("/plans")}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: D2, fontSize: 11, fontFamily: "'Rajdhani',sans-serif", textDecoration: "underline" }}>
                  {t("See plans and prices")}
                </button>
              </p>
            </form>
          </Card>
        </div>

        {snap && (
          <>
            <PayCard pay={snap.pay} title={t("Pay your administrator — MoMo or Bitcoin only")} />
            <ContactCard contact={snap.contact} title={t("Send the payment reference")} />
          </>
        )}

        {/* Requests + recent movements */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
          <Card>
            <CardTitle>{t("Your requests")}</CardTitle>
            {requests.length === 0 ? (
              <p style={{ fontSize: 13, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>{t("Nothing asked for yet.")}</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {requests.map(r => (
                  <div key={String(r.id)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 12px", background: "hsl(222 40% 8%)", borderRadius: 8, border: "1px solid hsl(222 40% 12%)" }}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: 12, color: "hsl(190 80% 92%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>{t("{n} min · {bucket}", { n: Number(r.minutes), bucket: MOD_LABELS[r.modality as Modality] ?? String(r.modality) })}</p>
                      <p style={{ fontSize: 10, color: "hsl(222 25% 40%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 2 }}>{fmtDate(r.created_at as string)}{r.admin_note ? ` — ${String(r.admin_note)}` : ""}</p>
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: r.status === "approved" ? "hsl(143 72% 55%)" : r.status === "rejected" ? "hsl(0 85% 65%)" : "hsl(35 100% 65%)", fontFamily: "'Orbitron',monospace" }}>{String(r.status)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardTitle><ArrowLeftRight style={{ width: 11, height: 11, verticalAlign: -1, marginRight: 6 }} />{t("Recent movements")}</CardTitle>
            {ledger.length === 0 ? (
              <p style={{ fontSize: 13, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>{t("No credits or debits recorded yet.")}</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {ledger.map((l, i) => {
                  const delta = Number(l.delta);
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "7px 12px", background: "hsl(222 40% 8%)", borderRadius: 7 }}>
                      <span style={{ fontSize: 11.5, color: "hsl(222 25% 60%)", fontFamily: "'Rajdhani',sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {t(MOD_LABELS[l.modality as Modality] ?? String(l.modality))} · {String(l.reason ?? l.kind)}
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
              style={{ marginTop: 10, background: "none", border: "none", cursor: "pointer", padding: 0, color: D2, fontSize: 11, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", textDecoration: "underline" }}>
              {t("Full history →")}
            </button>
          </Card>
        </div>
      </div>
      </Stage>
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
  if (!expiresAt) return t("renewing");
  const secs = Math.round((new Date(expiresAt).getTime() - now) / 1000);
  return secs > 0 ? t("{secs}s", { secs }) : t("expired");
}
