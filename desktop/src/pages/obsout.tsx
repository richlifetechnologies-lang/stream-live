import { useRef, useEffect } from "react";
import { FeedMark } from "../components/brand";

export default function ObsoutPage() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const tryGetStream = () => {
      try {
        const stream = (window.opener as any)?.__slRemoteStream as MediaStream | undefined;
        if (stream && videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch { /* cross-origin guard */ }
    };

    tryGetStream();

    const handler = (e: MessageEvent) => {
      if (e.data?.type === "stream-live-stream") {
        tryGetStream();
      }
      if (e.data === "stream-live-clear" && videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", background: "#000", overflow: "hidden", margin: 0, padding: 0 }}>
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
      <FeedMark size={Math.max(28, Math.round(window.innerHeight * 0.07))} />
    </div>
  );
}
