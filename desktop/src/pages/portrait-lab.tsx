import { useCallback, useEffect, useRef, useState } from "react";
import { drawOutputFrame, type FrameSource } from "../lib/vcam-frame";

// DEV-ONLY. Served by `vite` at /lab.html and never listed as a build input, so a
// packaged build contains none of this. lab-sample.png lives at the project root
// for the same reason — it is not in public/, so it never reaches dist.
//
// Shows the literal frames "Stream Live Camera" hands to Zoom/Teams/OBS, painted by
// the same drawOutputFrame the production pump calls. Three sources: your webcam, a
// wide sample photo, or a synthetic test frame. None of them starts a call, spends a
// minute, or touches an AI key.
const W = 1280, H = 720, EDGE = 26;
type Source = "camera" | "photo" | "test";

function paintTestFrame(c: HTMLCanvasElement, t: number) {
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#1b2a3a"); g.addColorStop(1, "#33465c");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.fillStyle = "#ff3b30"; ctx.fillRect(0, 0, EDGE, H);
  ctx.fillStyle = "#34c759"; ctx.fillRect(W - EDGE, 0, EDGE, H);
  ctx.fillStyle = "#ffcc00"; ctx.fillRect(0, 0, W, EDGE);
  ctx.fillStyle = "#00c7be"; ctx.fillRect(0, H - EDGE, W, EDGE);
  ctx.fillStyle = "#fff"; ctx.font = "bold 22px monospace"; ctx.textBaseline = "middle";
  ctx.fillText("TOP", W / 2 - 24, EDGE + 16);
  ctx.fillText("BOTTOM", W / 2 - 40, H - EDGE - 16);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(((t / 16) % W) - 6, EDGE, 12, H - EDGE * 2);
}

export default function PortraitLabPage() {
  const videoRef  = useRef<HTMLVideoElement | null>(null);
  const testRef   = useRef<HTMLCanvasElement | null>(null);
  const photoRef  = useRef<HTMLCanvasElement | null>(null);
  const landRef   = useRef<HTMLCanvasElement | null>(null);
  const portRef   = useRef<HTMLCanvasElement | null>(null);
  const timerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const srcRef    = useRef<Source>("camera");
  const [source, setSourceState] = useState<Source>("camera");
  const [note, setNote] = useState("Starting…");

  const setSource = useCallback((s: Source) => { srcRef.current = s; setSourceState(s); }, []);

  const pump = useCallback((t: number) => {
    const v = videoRef.current;
    if (!testRef.current) { testRef.current = document.createElement("canvas"); testRef.current.width = W; testRef.current.height = H; }
    const live = !!(v && v.srcObject && v.videoWidth > 0 && v.readyState >= 2);
    let src: FrameSource | null = null;
    if (srcRef.current === "photo" && photoRef.current) src = photoRef.current;
    else if (srcRef.current === "test") { paintTestFrame(testRef.current, t); src = testRef.current; }
    else src = live ? v : (paintTestFrame(testRef.current, t), testRef.current);
    const lc = landRef.current?.getContext("2d");
    const pc = portRef.current?.getContext("2d");
    if (lc) drawOutputFrame(lc, src, W, H, false);
    if (pc) drawOutputFrame(pc, src, W, H, true);
    timerRef.current = setTimeout(() => pump(performance.now()), 33);
  }, []);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    pump(0);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d")?.drawImage(img, 0, 0);
      photoRef.current = c;
    };
    // lab-sample.png is a local-only dev asset (gitignored), so a fresh clone may
    // not have it. Without it the photo button simply keeps the test pattern.
    img.onerror = () => { photoRef.current = null; };
    img.src = "/lab-sample.png";
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: W }, height: { ideal: H } }, audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(tr => tr.stop()); return; }
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => undefined); }
        setNote("Webcam live.");
      } catch {
        if (cancelled) return;
        setSource("photo");
        setNote("No webcam in this window — showing the wide sample photo. Same drawing code as a real call.");
      }
    })();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      stream?.getTracks().forEach(tr => tr.stop());
    };
  }, [pump, setSource]);

  const btn = (s: Source, label: string) => (
    <button key={s} onClick={() => setSource(s)}
      style={{
        padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 700,
        fontFamily: "'Orbitron',monospace", letterSpacing: "0.05em", textTransform: "uppercase",
        background: source === s ? "hsl(187 100% 52% / 0.15)" : "hsl(222 40% 8%)",
        border: `1px solid ${source === s ? "hsl(187 100% 52% / 0.5)" : "hsl(222 40% 14%)"}`,
        color: source === s ? "hsl(187 100% 52%)" : "hsl(222 25% 55%)",
      }}>
      {label}
    </button>
  );

  const cell = (label: string, sub: string, ref: React.RefObject<HTMLCanvasElement>) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 12, fontWeight: 700, color: "hsl(187 100% 52%)" }}>{label}</span>
        <span style={{ fontSize: 12, color: "hsl(222 25% 55%)" }}>{sub}</span>
      </div>
      <canvas ref={ref} width={W} height={H}
        style={{ width: "100%", maxWidth: 620, aspectRatio: "16/9", background: "#000", borderRadius: 12, border: "1px solid hsl(222 40% 14%)", transform: "scaleX(-1)" }} />
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "hsl(222 47% 4%)", color: "hsl(190 80% 96%)", padding: "28px 32px", fontFamily: "'Rajdhani',sans-serif" }}>
      <h1 style={{ fontFamily: "'Orbitron',monospace", fontSize: 16, fontWeight: 700, letterSpacing: "0.06em", margin: 0 }}>
        WHAT THE CALLING APP RECEIVES
      </h1>
      <p style={{ fontSize: 13, color: "hsl(222 25% 55%)", maxWidth: 760, marginTop: 8 }}>
        These are the exact frames the Stream Live Camera device sends, drawn by the same code the virtual
        camera uses. The device frame is always 1280x720, so portrait puts a tall 9:16 picture in the middle
        of it and fills that picture edge to edge — the person stays, the wide room at the sides is trimmed,
        exactly like the phone in your screenshot.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
        {btn("camera", "Webcam")}
        {btn("photo", "Sample photo")}
        {btn("test", "Test pattern")}
        <span style={{ fontSize: 12, color: "hsl(187 100% 52%)" }}>{note}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 28, marginTop: 18 }}>
        {cell("LANDSCAPE (16:9)", "what a widescreen call sends today", landRef)}
        {cell("PORTRAIT (9:16)", "the tall picture, filled", portRef)}
      </div>
      <video ref={videoRef} playsInline muted autoPlay style={{ position: "fixed", left: -9999, top: 0, width: 2, height: 2 }} />
    </div>
  );
}
