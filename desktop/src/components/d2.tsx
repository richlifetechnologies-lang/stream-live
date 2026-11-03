/**
 * Design 2 chrome — the one visual language every tab of the app shares.
 *
 * A page is: a head row (the section's name and its pills on the left, the number the
 * customer cares about on the right), then content that floats over the dark stage as
 * glass cards. Nothing here holds state, so a page can call these while it re-renders
 * at 30fps mid-call without React tearing their DOM down underneath a click.
 */
import { t } from "../lib/i18n";

export const D2 = "hsl(187 100% 52%)";

/** The dark stage every card floats on. Full-bleed, so the app reads as one surface. */
export function Stage({ children, minH = "calc(100vh - 88px)" }: { children: React.ReactNode; minH?: string }) {
  return (
    <div style={{
      position: "relative", minHeight: minH, padding: "22px 26px 26px",
      background: "radial-gradient(1200px 620px at 72% -8%, hsl(197 72% 12%) 0%, hsl(222 47% 4%) 62%)",
    }}>
      {children}
    </div>
  );
}

/** A glass card: the surface every panel on every tab is made of. */
export function Card({ children, tour, accent, pad = 18, style }: {
  children: React.ReactNode; tour?: string; accent?: string; pad?: number | string; style?: React.CSSProperties;
}) {
  const a = accent ?? D2;
  return (
    <div data-tour={tour} style={{
      background: "hsl(228 62% 4% / 0.86)", backdropFilter: "blur(16px)",
      border: `1px solid ${a}38`, borderRadius: 16, padding: pad,
      boxShadow: `0 12px 40px hsl(226 80% 2% / 0.55), 0 0 26px ${a}0f`,
      minWidth: 0, ...style,
    }}>
      {children}
    </div>
  );
}

/** The small uppercase heading that opens a card, in the app's own voice. */
export function CardTitle({ children, accent }: { children: React.ReactNode; accent?: string }) {
  return (
    <p style={{
      fontSize: 10, fontWeight: 700, color: accent ?? D2, textTransform: "uppercase",
      letterSpacing: "0.14em", fontFamily: "'Orbitron',monospace", marginBottom: 12,
    }}>
      {children}
    </p>
  );
}

/**
 * A page's opening row: its name and pills to the left, one floating summary card to the
 * right. Every tab uses it, so the eye finds the same shape wherever the customer lands.
 *
 * The text block shrinks (flex 1 1 0) rather than pushing the card off the line: the card is
 * the minutes reading and it belongs in this corner at every window width, so the pills fold
 * inside the text block instead.
 */
export function PageHead({ name, note, pills, card, badge, tour }: {
  name: string; note?: string; pills?: React.ReactNode; card?: React.ReactNode; badge?: React.ReactNode; tour?: string;
}) {
  return (
    <div data-tour={tour} style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, flexWrap: "wrap", marginBottom: 20 }}>
      <div style={{ flex: "1 1 0", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: pills ? 12 : 0 }}>
          <h1 style={{
            fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 15,
            letterSpacing: "0.2em", textTransform: "uppercase", color: "hsl(190 80% 96%)",
            margin: 0,
          }}>
            {t(name)}
          </h1>
          {badge}
        </div>
        {note && (
          <p style={{ fontSize: 12.5, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif", margin: "7px 0 0", maxWidth: 620, lineHeight: 1.5 }}>
            {t(note)}
          </p>
        )}
        {pills}
      </div>
      {card && <div style={{ width: 350, maxWidth: "100%", flexShrink: 0 }}>{card}</div>}
    </div>
  );
}

/** One pill of a pill row — the shape the stream page's three call types use. */
export function Pill({ active, label, sub, Icon, color = D2, onClick }: {
  active: boolean; label: string; sub?: string; color?: string;
  Icon?: React.ComponentType<{ style?: React.CSSProperties }>; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 8, padding: "9px 15px",
      borderRadius: 999, cursor: "pointer", transition: "all 0.2s", textAlign: "left",
      background: active ? `${color}14` : "hsl(228 62% 4% / 0.7)",
      border: `1px solid ${active ? `${color}80` : "hsl(222 40% 13%)"}`,
      boxShadow: active ? `0 0 22px ${color}2e` : "none",
    }}>
      {Icon && <Icon style={{ width: 15, height: 15, color: active ? color : "hsl(222 25% 45%)", flexShrink: 0 }} />}
      <span style={{
        fontSize: 11, fontWeight: 800, fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em",
        textTransform: "uppercase", color: active ? color : "hsl(222 25% 50%)", whiteSpace: "nowrap",
      }}>
        {t(label)}
      </span>
      {sub && (
        <span style={{ fontSize: 11.5, fontWeight: 600, fontFamily: "'Rajdhani',sans-serif", color: active ? "hsl(190 60% 85%)" : "hsl(222 25% 38%)" }}>
          {t(sub)}
        </span>
      )}
    </button>
  );
}

/** A row of pills, wrapping on a narrow window instead of cutting names off. */
export function PillRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>{children}</div>;
}

/** One figure inside a card: the label, then the number that answers it. */
export function Stat({ label, value, accent, sub }: { label: string; value: React.ReactNode; accent?: string; sub?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <p style={{
        fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
        fontFamily: "'Orbitron',monospace", color: "hsl(222 25% 50%)", margin: "0 0 5px", whiteSpace: "nowrap",
      }}>
        {t(label)}
      </p>
      <p style={{
        fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 19, lineHeight: 1.1, margin: 0,
        color: accent ?? "hsl(190 80% 96%)", fontVariantNumeric: "tabular-nums", wordBreak: "break-word",
      }}>
        {value}
      </p>
      {sub && (
        <p style={{ fontSize: 11, color: "hsl(222 25% 48%)", fontFamily: "'Rajdhani',sans-serif", margin: "5px 0 0", lineHeight: 1.45 }}>{t(sub)}</p>
      )}
    </div>
  );
}

/** The primary action, in the app's own cyan. */
export function PrimaryButton({ children, onClick, disabled, tour, style }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; tour?: string; style?: React.CSSProperties;
}) {
  return (
    <button data-tour={tour} onClick={onClick} disabled={disabled} style={{
      height: 40, padding: "0 20px", borderRadius: 10, cursor: disabled ? "not-allowed" : "pointer",
      background: disabled ? "hsl(222 40% 11%)" : `linear-gradient(135deg, ${D2} 0%, hsl(200 100% 45%) 100%)`,
      border: "none", color: disabled ? "hsl(222 25% 40%)" : "hsl(222 47% 4%)",
      fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase",
      boxShadow: disabled ? "none" : "0 0 26px hsl(187 100% 52% / 0.3)",
      display: "flex", alignItems: "center", justifyContent: "center", gap: 8, ...style,
    }}>
      {children}
    </button>
  );
}
