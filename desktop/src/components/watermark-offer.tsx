import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Sparkles } from "lucide-react";
import { gateway } from "../lib/gateway";

const GOLD = "hsl(38 100% 58%)";

/**
 * The trial's one visible limitation is the mark on the AI picture, and the offer
 * that removes it has to be impossible to miss the moment the free minute is gone —
 * which is exactly when a user decides whether to pay.
 *
 * Not dismissible on purpose, and driven by the gateway's own paid flag rather than
 * a balance: the instant minutes are credited the account stops being a trial
 * account and this leaves with the next snapshot, whether or not the money has been
 * spent yet.
 *
 * While the seller has online payment open the button goes straight to the payment
 * page — choosing a package and paying is one click away, not a form to fill in.
 */
export function WatermarkOffer({
  paid,
  videoMinutesLeft,
  ctaLabel = "Buy minutes",
  ctaHref = "/minutes",
  ctaOnClick,
}: {
  paid: boolean;
  videoMinutesLeft: number | null;
  /** Where the button leads when there is no online till. */
  ctaLabel?: string;
  ctaHref?: string;
  /** Set instead of a route when the answer is further up or down the same page. */
  ctaOnClick?: () => void;
}) {
  const [, setLocation] = useLocation();
  const [page, setPage] = useState<string | null>(null);

  useEffect(() => {
    if (paid || videoMinutesLeft === null || videoMinutesLeft >= 1) return;
    let alive = true;
    gateway.checkout().then(c => { if (alive && c?.enabled) setPage(c.page); });
    return () => { alive = false; };
  }, [paid, videoMinutesLeft]);

  if (paid) return null;
  // A minute is the smallest thing the app sells, and under a minute no call can
  // finish, so that — not an exact zero — is where the trial counts as spent. With
  // no video bucket in view there is nothing to say yet.
  if (videoMinutesLeft === null || videoMinutesLeft >= 1) return null;

  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap",
      background: "linear-gradient(135deg, hsl(38 100% 55% / 0.15) 0%, hsl(18 90% 48% / 0.1) 100%)",
      border: `1.5px solid ${GOLD}`, borderRadius: 14, padding: "18px 20px", marginBottom: 14,
      boxShadow: "0 18px 46px hsl(226 80% 2% / 0.55)",
    }}>
      <Sparkles style={{ width: 26, height: 26, color: GOLD, flexShrink: 0, marginTop: 2 }} />

      <div style={{ flex: 1, minWidth: 260 }}>
        <p style={{
          margin: "0 0 5px", fontSize: 10, fontWeight: 700, letterSpacing: "0.16em",
          textTransform: "uppercase", fontFamily: "'Orbitron', monospace", color: GOLD,
        }}>
          Your free minute is used
        </p>
        <h2 style={{
          margin: 0, fontSize: 19, fontWeight: 700, lineHeight: 1.25,
          fontFamily: "'Orbitron', monospace", color: "hsl(45 100% 96%)",
        }}>
          The watermark was the trial. Minutes you buy have none.
        </h2>
        <p style={{
          margin: "9px 0 0", fontSize: 14, lineHeight: 1.55,
          fontFamily: "'Rajdhani', sans-serif", color: "hsl(40 60% 88%)",
        }}>
          Free trial video carries a mark on the picture. That mark is the only thing the
          trial limits. Once minutes are in your account your output video is clean — the
          same picture into OBS, into a call, anywhere you send it.
        </p>
      </div>

      {page ? (
        <a href={page} target="_blank" rel="noreferrer"
          style={{
            alignSelf: "center", display: "inline-block", padding: "14px 22px", borderRadius: 11, border: "none",
            background: GOLD, color: "hsl(222 47% 6%)", fontWeight: 700, fontSize: 14,
            fontFamily: "'Orbitron', monospace", letterSpacing: "0.04em", cursor: "pointer",
            whiteSpace: "nowrap", boxShadow: `0 0 26px ${GOLD}55`, textDecoration: "none",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.filter = "brightness(1.08)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = "none"; }}
        >
          Buy minutes
        </a>
      ) : (
      <button
        onClick={() => (ctaOnClick ? ctaOnClick() : setLocation(ctaHref))}
        style={{
          alignSelf: "center", padding: "14px 22px", borderRadius: 11, border: "none",
          background: GOLD, color: "hsl(222 47% 6%)", fontWeight: 700, fontSize: 14,
          fontFamily: "'Orbitron', monospace", letterSpacing: "0.04em", cursor: "pointer",
          whiteSpace: "nowrap", boxShadow: `0 0 26px ${GOLD}55`,
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.filter = "brightness(1.08)"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = "none"; }}
      >
        {ctaLabel}
      </button>
      )}
    </div>
  );
}
