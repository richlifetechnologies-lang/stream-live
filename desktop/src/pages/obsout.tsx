import { useRef, useEffect } from "react";

export default function ObsoutPage() {
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

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#000", overflow: "hidden", margin: 0, padding: 0 }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: "scaleX(-1)",
          display: "block",
        }}
      />
    </div>
  );
}
