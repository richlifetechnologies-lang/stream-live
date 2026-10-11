import { useRef, useEffect, useState, useCallback } from "react";

// Portrait (9:16) OBS clean-output window.
// The AI stream is natively 16:9, so it must be fit into the portrait frame.
// Two user-selectable fit modes:
//   "fill" — blurred cover-fit background + sharp contained foreground (no crop)
//   "crop" — foreground cover-fits the whole window (full-bleed, edges cut off)
// The toggle control auto-hides after idle so it never shows in an OBS capture.
type FitMode = "fill" | "crop";

export default function ObsoutPortraitPage() {
  const bgRef = useRef<HTMLVideoElement>(null);
  const fgRef = useRef<HTMLVideoElement>(null);
  const [fit, setFit] = useState<FitMode>("fill");
  const [uiVisible, setUiVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const attach = () => {
      try {
        const stream = (window.opener as any)?.__ssRemoteStream as MediaStream | undefined;
        if (!stream) return;
        if (bgRef.current && bgRef.current.srcObject !== stream) bgRef.current.srcObject = stream;
        if (fgRef.current && fgRef.current.srcObject !== stream) fgRef.current.srcObject = stream;
      } catch { /* cross-origin guard */ }
    };

    attach();

    const handler = (e: MessageEvent) => {
      if (e.data?.type === "stream-studio-stream") attach();
      if (e.data === "stream-studio-clear") {
        if (bgRef.current) bgRef.current.srcObject = null;
        if (fgRef.current) fgRef.current.srcObject = null;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Auto-hide the toggle after 2.5s of no mouse movement.
  const bumpUi = useCallback(() => {
    setUiVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setUiVisible(false), 2500);
  }, []);

  useEffect(() => {
    bumpUi();
    window.addEventListener("mousemove", bumpUi);
    return () => {
      window.removeEventListener("mousemove", bumpUi);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [bumpUi]);

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#000", overflow: "hidden", margin: 0, padding: 0, position: "relative" }}>
      {/* Blurred cover-fit background — only used in "fill" mode */}
      {fit === "fill" && (
        <video
          ref={bgRef}
          autoPlay
          playsInline
          muted
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: "scaleX(-1)",
            filter: "blur(28px) brightness(0.55)",
          }}
        />
      )}
      {/* Sharp foreground — contained in "fill", full-bleed cover in "crop" */}
      <video
        ref={fgRef}
        autoPlay
        playsInline
        muted
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: fit === "crop" ? "cover" : "contain",
          transform: "scaleX(-1)",
        }}
      />

      {/* Fit-mode toggle — faded grey + auto-hides so it never distracts from,
          or shows up in, the OBS capture. */}
      <div
        style={{
          position: "absolute",
          bottom: 14,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          gap: 2,
          padding: 3,
          borderRadius: 20,
          background: "rgba(20,20,20,0.28)",
          border: "1px solid rgba(255,255,255,0.07)",
          opacity: uiVisible ? 0.32 : 0,
          transition: "opacity 0.5s ease",
          pointerEvents: uiVisible ? "auto" : "none",
          zIndex: 10,
        }}
      >
        {(["fill", "crop"] as FitMode[]).map(m => (
          <button
            key={m}
            onClick={() => { setFit(m); bumpUi(); }}
            style={{
              height: 22,
              padding: "0 10px",
              borderRadius: 16,
              border: "none",
              cursor: "pointer",
              fontSize: 10,
              fontWeight: 600,
              fontFamily: "monospace",
              letterSpacing: 0.4,
              background: fit === m ? "rgba(255,255,255,0.12)" : "transparent",
              color: fit === m ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.4)",
            }}
          >
            {m === "fill" ? "BARS" : "CROP"}
          </button>
        ))}
      </div>
    </div>
  );
}
