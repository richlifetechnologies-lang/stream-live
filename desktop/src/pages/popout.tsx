import { useRef, useEffect } from "react";

export default function PopoutPage() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const tryGetStream = () => {
      try {
        const stream = (window.opener as any)?.__ssRemoteStream as MediaStream | undefined;
        if (stream && videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch { /* cross-origin guard */ }
    };

    tryGetStream();

    const handler = (e: MessageEvent) => {
      if (e.data?.type === "stream-studio-stream") {
        tryGetStream();
      }
      if (e.data === "stream-studio-clear" && videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleStop = () => {
    if (window.opener) window.opener.postMessage("stream-studio-stop", "*");
    window.close();
  };

  const handleReconnect = () => {
    if (window.opener) window.opener.postMessage("stream-studio-reconnect", "*");
  };

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#000", position: "relative", overflow: "hidden" }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }}
      />
      <div style={{
        position: "absolute", bottom: 12, right: 12,
        display: "flex", gap: 8,
        opacity: 0,
        transition: "opacity 0.2s",
      }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = "0"; }}
      >
        <button
          onClick={handleReconnect}
          style={{
            padding: "6px 14px", borderRadius: 6,
            background: "hsl(187 100% 52% / 0.9)", color: "hsl(222 47% 4%)",
            border: "none", fontWeight: 700, fontSize: 11,
            fontFamily: "monospace", letterSpacing: 1, cursor: "pointer",
          }}
        >
          RECONNECT
        </button>
        <button
          onClick={handleStop}
          style={{
            padding: "6px 14px", borderRadius: 6,
            background: "rgba(220,38,38,0.85)", color: "#fff",
            border: "none", fontWeight: 700, fontSize: 11,
            fontFamily: "monospace", letterSpacing: 1, cursor: "pointer",
          }}
        >
          STOP
        </button>
      </div>
    </div>
  );
}
