import art from "../assets/stream-live-login.png";
import mark from "../assets/stream-live-mark.png";

export const LOGIN_ART = art;
export const LOGO_MARK = mark;

// The poster is square and the window is 14:9, so `cover` crops the top and
// bottom. The poster carries its own logo lockup in the top band — cropping
// downward keeps that band out of frame so the real <Logo> is the only mark.
export function ArtBackdrop() {
  return (
    <>
      <img
        src={art}
        alt=""
        aria-hidden
        draggable={false}
        style={{
          position: "absolute", inset: "-2%", width: "104%", height: "104%",
          objectFit: "cover", objectPosition: "50% 68%",
          filter: "brightness(0.4) saturate(1.05)",
          animation: "sl-art-drift 34s ease-in-out infinite alternate",
        }}
      />
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        background:
          "linear-gradient(180deg, hsl(228 65% 2% / 0.74) 0%, hsl(228 65% 2% / 0.58) 42%, hsl(228 65% 2% / 0.88) 100%)",
      }} />
      <style>{`@keyframes sl-art-drift{from{transform:scale(1.02)}to{transform:scale(1.09) translateY(-1.2%)}}`}</style>
    </>
  );
}

export function Logo({ size = 40, word = false, style }: {
  size?: number; word?: boolean; style?: React.CSSProperties;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: word ? size * 0.28 : 0, ...style }}>
      <img
        src={mark}
        alt="Stream Live"
        draggable={false}
        style={{
          width: size * 1.16, height: size, objectFit: "contain",
          filter: "drop-shadow(0 2px 10px hsl(212 100% 52% / 0.35))",
        }}
      />
      {word && (
        <span style={{
          fontFamily: "'Orbitron', monospace", fontWeight: 700, letterSpacing: "0.08em",
          fontSize: size * 0.5, color: "hsl(190 80% 96%)", whiteSpace: "nowrap",
        }}>
          STREAM&nbsp;LIVE
        </span>
      )}
    </span>
  );
}
