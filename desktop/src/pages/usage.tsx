import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "../components/layout";
import { RefreshCw, History, ArrowLeftRight, Inbox } from "lucide-react";
import { gateway, useAccount } from "../lib/gateway";
import { toUserMessage } from "../lib/end-reason";

const C = "hsl(187 100% 52%)";

type CallRow = {
  tab: string;
  started_at: string;
  billed_minutes: number;
  device_id: string | null;
};

type LedgerRow = {
  created_at: string;
  modality: string;
  kind: string;
  delta: number;
  balance_after: number | null;
  reason: string | null;
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fmtMins(n: number | null | undefined) {
  return (Number(n) || 0).toFixed(2);
}

const TAB_LABELS: Record<string, string> = {
  "video-only": "Video Call",
  "audio-only": "Audio Call",
  "video-audio": "Video + Audio",
};

function Panel({ icon: Icon, title, count, onRefresh, children }: {
  icon: React.ElementType; title: string; count?: number;
  onRefresh?: () => void; children: React.ReactNode;
}) {
  return (
    <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid hsl(222 40% 11%)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon style={{ width: 14, height: 14, color: C }} />
          <span style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 11, letterSpacing: "0.1em", color: "hsl(190 80% 96%)" }}>{title}</span>
          {count !== undefined && count > 0 && (
            <span style={{ padding: "2px 8px", borderRadius: 20, background: "hsl(187 100% 52% / 0.12)", border: "1px solid hsl(187 100% 52% / 0.25)", fontSize: 10, color: C, fontFamily: "'Orbitron',monospace", fontWeight: 700 }}>
              {count}
            </span>
          )}
        </div>
        {onRefresh && (
          <button onClick={onRefresh} style={{
            display: "flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 7,
            background: "hsl(222 40% 11%)", border: "1px solid hsl(222 40% 18%)", cursor: "pointer",
            color: "hsl(222 25% 60%)", fontSize: 11, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif",
          }}>
            <RefreshCw style={{ width: 11, height: 11 }} /> Refresh
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

export default function UsagePage() {
  const account = useAccount();
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!account.signedIn) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const { data, error: qErr } = await gateway.raw
        .from("usage_sessions")
        .select("tab, started_at, billed_minutes, device_id")
        .order("started_at", { ascending: false })
        .limit(100);
      if (qErr) throw new Error(qErr.message);
      setCalls((data ?? []) as unknown as CallRow[]);
      setLedger((await gateway.ledger(100)) as unknown as LedgerRow[]);
    } catch (e) {
      setError(toUserMessage(e, "We couldn't load your call history. Try again in a moment."));
    } finally {
      setLoading(false);
    }
  }, [account.signedIn]);

  useEffect(() => { void load(); }, [load]);

  const Empty = ({ text }: { text: string }) => (
    <div style={{ padding: "48px 20px", textAlign: "center" }}>
      <div style={{ width: 52, height: 52, borderRadius: "50%", background: "hsl(222 40% 9%)", border: "1px solid hsl(222 40% 14%)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
        <Inbox style={{ width: 22, height: 22, color: "hsl(222 25% 35%)" }} />
      </div>
      <p style={{ fontSize: 13, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif" }}>{text}</p>
    </div>
  );

  const header = (cols: string[], widths: string) => (
    <div style={{ display: "grid", gridTemplateColumns: widths, gap: 0, padding: "10px 20px", borderBottom: "1px solid hsl(222 40% 9%)" }}>
      {cols.map(h => (
        <span key={h} style={{ fontSize: 9, fontWeight: 700, color: "hsl(222 25% 38%)", textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace" }}>{h}</span>
      ))}
    </div>
  );

  return (
    <AppLayout>
      <div style={{ padding: "28px 32px", maxWidth: 900, margin: "0 auto" }}>
        <div style={{ marginBottom: 24, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 20, letterSpacing: "0.06em", color: "hsl(190 80% 96%)", marginBottom: 4 }}>
              Usage History
            </h1>
            <p style={{ color: "hsl(222 25% 50%)", fontSize: 14, fontFamily: "'Rajdhani',sans-serif" }}>
              Your metered calls and credit movements, straight from the gateway
            </p>
          </div>
          <button onClick={() => void load()} disabled={loading || !account.signedIn} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
            background: "hsl(187 100% 52% / 0.12)", border: `1px solid ${C}44`, cursor: "pointer",
            color: C, fontSize: 12, fontWeight: 700, fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em",
            opacity: loading || !account.signedIn ? 0.6 : 1,
          }}>
            <RefreshCw style={{ width: 12, height: 12 }} /> {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {!account.signedIn ? (
          <Panel icon={History} title="ACCOUNT">
            <Empty text="Sign in to see your call history and credit ledger." />
          </Panel>
        ) : (
          <>
            {error && (
              <div style={{ marginBottom: 16, padding: "12px 16px", borderRadius: 10, background: "hsl(0 85% 40% / 0.12)", border: "1px solid hsl(0 85% 40% / 0.3)", color: "hsl(0 85% 70%)", fontSize: 13, fontFamily: "'Rajdhani',sans-serif" }}>
                {error}
              </div>
            )}

            <div style={{ marginBottom: 24 }}>
              <Panel icon={History} title="CALL HISTORY" count={calls.length} onRefresh={() => void load()}>
                {calls.length === 0 && !loading ? (
                  <Empty text="No calls yet. Start a stream to see metered sessions here." />
                ) : (
                  <div>
                    {header(["Date / Time", "Tab", "Minutes used", "Device"], "1.3fr 1.1fr 0.9fr 1fr")}
                    <div style={{ maxHeight: 360, overflowY: "auto" }}>
                      {calls.map((s, i) => (
                        <div key={`${s.started_at}-${i}`} style={{
                          display: "grid", gridTemplateColumns: "1.3fr 1.1fr 0.9fr 1fr", gap: 0, padding: "12px 20px",
                          borderBottom: i < calls.length - 1 ? "1px solid hsl(222 40% 8%)" : "none",
                          background: i % 2 === 0 ? "transparent" : "hsl(222 47% 4% / 0.5)",
                        }}>
                          <span style={{ fontSize: 13, color: "hsl(190 80% 90%)", fontFamily: "'Rajdhani',sans-serif", fontWeight: 600, alignSelf: "center" }}>{fmtDate(s.started_at)}</span>
                          <span style={{ fontSize: 13, color: C, fontFamily: "'Rajdhani',sans-serif", fontWeight: 600, alignSelf: "center" }}>{TAB_LABELS[s.tab] ?? s.tab}</span>
                          <span style={{ fontSize: 13, color: "hsl(190 80% 85%)", fontFamily: "'Orbitron',monospace", fontWeight: 700, alignSelf: "center" }}>{fmtMins(s.billed_minutes)}</span>
                          <span style={{ fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", alignSelf: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.device_id ?? ""}>{s.device_id ?? "—"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Panel>
            </div>

            <Panel icon={ArrowLeftRight} title="CREDIT LEDGER" count={ledger.length} onRefresh={() => void load()}>
              {ledger.length === 0 && !loading ? (
                <Empty text="No credit movements yet. Your administrator tops up buckets manually." />
              ) : (
                <div>
                  {header(["Date / Time", "Bucket", "Type", "Change", "Balance After", "Reason"], "1.3fr 0.9fr 0.9fr 0.8fr 0.9fr 1.2fr")}
                  <div style={{ maxHeight: 360, overflowY: "auto" }}>
                    {ledger.map((l, i) => {
                      const delta = Number(l.delta);
                      const positive = delta > 0;
                      return (
                        <div key={`${l.created_at}-${i}`} style={{
                          display: "grid", gridTemplateColumns: "1.3fr 0.9fr 0.9fr 0.8fr 0.9fr 1.2fr", gap: 0, padding: "12px 20px",
                          borderBottom: i < ledger.length - 1 ? "1px solid hsl(222 40% 8%)" : "none",
                          background: i % 2 === 0 ? "transparent" : "hsl(222 47% 4% / 0.5)",
                        }}>
                          <span style={{ fontSize: 13, color: "hsl(190 80% 90%)", fontFamily: "'Rajdhani',sans-serif", fontWeight: 600, alignSelf: "center" }}>{fmtDate(l.created_at)}</span>
                          <span style={{ fontSize: 12, color: "hsl(222 25% 60%)", fontFamily: "'Rajdhani',sans-serif", alignSelf: "center" }}>{l.modality.replace("_", " ")}</span>
                          <span style={{ fontSize: 12, color: "hsl(222 25% 60%)", fontFamily: "'Rajdhani',sans-serif", alignSelf: "center" }}>{l.kind}</span>
                          <span style={{ fontSize: 13, color: positive ? "hsl(143 72% 55%)" : "hsl(0 75% 62%)", fontFamily: "'Orbitron',monospace", fontWeight: 700, alignSelf: "center" }}>{positive ? "+" : ""}{fmtMins(delta)}</span>
                          <span style={{ fontSize: 13, color: "hsl(190 80% 85%)", fontFamily: "'Orbitron',monospace", fontWeight: 600, alignSelf: "center" }}>{l.balance_after === null ? "∞" : fmtMins(l.balance_after)}</span>
                          <span style={{ fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", alignSelf: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l.reason ?? ""}>{l.reason ?? "—"}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </Panel>

            <p style={{ marginTop: 12, fontSize: 11, color: "hsl(222 25% 35%)", fontFamily: "'Rajdhani',sans-serif", textAlign: "right" }}>
              Minutes shown are what each call took from its bucket. Buckets never expire.
            </p>
          </>
        )}
      </div>
    </AppLayout>
  );
}
