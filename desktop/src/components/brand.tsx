import art from "../assets/stream-live-login.png";

export const LOGIN_ART = art;

// The poster is square and the window is 14:9, so `cover` crops the top and
// bottom. Biasing the crop upward keeps the wordmark and the camera panel in
// frame; the drift is what stops the crop line from reading as a static cut.
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
          objectFit: "cover", objectPosition: "50% 14%",
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
