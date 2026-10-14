import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { AppLayout, RAIL_W } from "../components/layout";
import { useToast } from "../hooks/use-toast";
import {
  getSavedVoices, addSavedVoice, removeSavedVoice, type SavedVoice,
} from "../lib/credentials";
import { gateway, deviceId, useAccount, bucketFor, hasMinutes, modalityForTab, refreshBalances, beginLease, updateLease, endLease, markMedia } from "../lib/gateway";
import { drainOf } from "../lib/minutes";
import { MinuteMeter } from "../components/meter";
import { CABLE_ANY_RE, CABLE_NAME, CABLE_OUTPUT_RE, IS_MAC } from "../lib/platform";
import { GatewayError, type TabName } from "@stream-live/client";
import { endReasonMessage, toUserMessage } from "../lib/end-reason";
import {
  Zap, Square, Play, Camera, Monitor, Maximize2, RefreshCw,
  ChevronDown, Image, Loader2, X, Settings, Mic, Wifi, WifiOff,
  Volume2, Upload, Trash2, Video, Headphones, VideoIcon, Smartphone, CameraOff,
} from "lucide-react";
import { encode, decode } from "@msgpack/msgpack";

// ─── Branding ─────────────────────────────────────────────────────────────────
const APP = "Stream Live";

// ─── Tab definitions ──────────────────────────────────────────────────────────
type TabId = "video-audio" | "audio-only" | "video-only";
const TABS: { id: TabId; label: string; sub: string; Icon: typeof Video; color: string; glow: string }[] = [
  {
    id: "video-audio",
    label: "Video + Audio",
    sub: "AI video with voice cloning",
    Icon: VideoIcon,
    color: "hsl(187 100% 52%)",       // cyan
    glow:  "hsl(187 100% 52% / 0.25)",
  },
  {
    id: "audio-only",
    label: "Audio Call",
    sub: "Voice cloning only",
    Icon: Headphones,
    color: "hsl(265 90% 65%)",        // purple
    glow:  "hsl(265 90% 65% / 0.25)",
  },
  {
    id: "video-only",
    label: "Video Call",
    sub: "AI video, natural voice",
    Icon: Video,
    color: "hsl(35 100% 55%)",        // amber/orange
    glow:  "hsl(35 100% 55% / 0.25)",
  },
];

// ─── Per-tab isolated state ────────────────────────────────────────────────────
// Each tab (Video+Audio / Audio Call / Video Call) is an independent workspace:
// its own selected camera & mic, style, prompt, reference image and voice-clone
// settings. This hook stores a separate value per TabId but exposes the SAME
// [value, setValue] shape as useState, so call sites are unchanged and switching
// tabs never leaks one tab's inputs/uploads into another.
const TAB_IDS: TabId[] = ["video-audio", "audio-only", "video-only"];
function usePerTabState<T>(activeTab: TabId, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [store, setStore] = useState<Record<TabId, T>>(() => {
    const base = {} as Record<TabId, T>;
    for (const id of TAB_IDS) base[id] = initial;
    return base;
  });
  const setValue = useCallback((v: T | ((prev: T) => T)) => {
    setStore(prev => ({ ...prev, [activeTab]: typeof v === "function" ? (v as (p: T) => T)(prev[activeTab]) : v }));
  }, [activeTab]);
  return [store[activeTab], setValue];
}

// ─── Style presets ────────────────────────────────────────────────────────────
const STYLES = [
  { id: "hyper-real",  label: "HYPER-REAL",  color: "#00d2d3", prompt: "photorealistic human, ultra-high-definition, natural skin texture, cinematic lighting, professional photography" },
  { id: "anime",       label: "ANIME",        color: "#a29bfe", prompt: "anime art style, cel shading, vibrant colors, clean lines, studio animation quality" },
  { id: "cinematic",   label: "CINEMATIC",    color: "#fdcb6e", prompt: "cinematic film look, dramatic lighting, movie quality, depth of field, anamorphic lens flare" },
  { id: "cyberpunk",   label: "CYBERPUNK",    color: "#fd79a8", prompt: "cyberpunk style, neon lights, futuristic city, chrome and neon, night scene, blade runner aesthetic" },
  { id: "fantasy",     label: "FANTASY",      color: "#55efc4", prompt: "fantasy art style, ethereal glow, mystical atmosphere, magical lighting, painterly quality" },
  { id: "horror",      label: "HORROR",       color: "#e17055", prompt: "horror film style, dark and sinister, dramatic shadows, unsettling atmosphere, desaturated with deep red accents" },
  { id: "neon-noir",   label: "NEON NOIR",    color: "#74b9ff", prompt: "neon noir style, rain-soaked streets, neon reflections, deep shadows, film noir meets cyberpunk" },
  { id: "watercolor",  label: "WATERCOLOR",   color: "#81ecec", prompt: "watercolor painting, soft brushstrokes, artistic, fluid colors, traditional art technique" },
  { id: "sketch",      label: "SKETCH",       color: "#dfe6e9", prompt: "pencil sketch style, hand-drawn, graphite lines, artistic rendering, detailed crosshatching" },
] as const;
type StyleId = typeof STYLES[number]["id"];

// ─── Built-in voices ──────────────────────────────────────────────────────────
const BUILTIN_VOICES = [
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George — warm male" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam — articulate male" },
  { id: "XB0fDUnXU5powFXDhCwa", name: "Charlotte — seductive female" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice — confident female" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily — warm female" },
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian — deep male" },
  { id: "N2lVS1w4EtoT3dr4eOWO", name: "Callum — intense male" },
  { id: "iP95p4xoKVk53GoZ742B", name: "Chris — casual male" },
];

const C  = "hsl(187 100% 52%)";
const VC = "hsl(265 90% 65%)";

function formatTime(s: number) {
  return `${Math.floor(s / 60).toString().padStart(2, "0")}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

// ─── Virtual-device filters ────────────────────────────────────────────────────
// Virtual cameras (OBS Virtual Camera, etc.) emit black frames when their host
// app isn't running, and virtual audio devices are loopback cables — not real
// input hardware. Filter them out of the picker so the app defaults to a real
// webcam/mic instead of a blank feed.
function isVirtualCamLabel(label: string) {
  // "Stream Live Camera" is our own virtual camera (UnityCapture) — picking it as
  // input feeds our AI output back into itself, so it must be excluded alongside
  // the legacy "Stream Studio Camera" name and other virtual cams.
  return /(obs virtual camera|stream live camera|stream studio camera|richx[\s_-]*cam|virtual camera|vcam)/i.test(label);
}
function isVirtualMicLabel(label: string) {
  return /(vb-cable|vb-audio|blackhole|stream live (microphone|speaker)|stream studio (microphone|speaker)|virtual (audio|cable|mic))/i.test(label);
}

// ─── Audio sync pipeline ──────────────────────────────────────────────────────
// Captures the selected mic, applies a cross-correlation delay to match
// AI video output latency, and returns a delayed audio destination node.

const WINDOW_MS = 60;
const BUF_SECS  = 6;
const BUF_LEN   = Math.round((BUF_SECS * 1000) / WINDOW_MS);
const MAX_DELAY = 4.0;
const MIN_DELAY = 0.0;

// ─── Microphone capture constraints ──────────────────────────────────────────
// Browser-native noise cancellation: suppresses background/external noise,
// removes echo and normalises level. When the user turns it off we request the
// raw mic signal instead (all three processing flags disabled).
function micAudioConstraints(deviceId: string | undefined, noiseCancel: boolean, sampleRate?: number): MediaTrackConstraints {
  const c: MediaTrackConstraints = {
    echoCancellation: noiseCancel,
    noiseSuppression: noiseCancel,
    autoGainControl: noiseCancel,
  };
  if (sampleRate) c.sampleRate = sampleRate;
  if (deviceId) c.deviceId = { exact: deviceId };
  return c;
}

class AudioSyncPipeline {
  private audioCtx:   AudioContext | null = null;
  private analyser:   AnalyserNode  | null = null;
  private delayNode:  DelayNode     | null = null;
  private dest:       MediaStreamAudioDestinationNode | null = null;
  private freqData:   Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private audioSig:   number[]      = [];
  private videoSig:   number[]      = [];
  private offCanvas:  OffscreenCanvas | null = null;
  private offCtx:     OffscreenCanvasRenderingContext2D | null = null;
  private prevPixels: Uint8ClampedArray | null = null;
  private timer:      ReturnType<typeof setInterval> | null = null;
  private videoEl:    HTMLVideoElement | null = null;
  private micStream:  MediaStream | null = null;

  detectedDelay = 0.8;
  vuLevel = 0;
  onUpdate?: (delay: number, vu: number) => void;

  async start(videoEl: HTMLVideoElement, micDeviceId?: string, noiseCancel = true): Promise<MediaStreamAudioDestinationNode | null> {
    this.videoEl = videoEl;
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: micAudioConstraints(micDeviceId, noiseCancel, 48000),
        video: false,
      });
      const ctx = new AudioContext({ sampleRate: 48000 });
      const src = ctx.createMediaStreamSource(this.micStream);
      const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      this.freqData = new Uint8Array(analyser.frequencyBinCount);
      const delay = ctx.createDelay(MAX_DELAY + 0.5); delay.delayTime.value = this.detectedDelay;
      const gain = ctx.createGain(); gain.gain.value = 1.0;
      const dest = ctx.createMediaStreamDestination();
      src.connect(analyser); analyser.connect(delay); delay.connect(gain); gain.connect(dest);
      this.audioCtx = ctx; this.analyser = analyser; this.delayNode = delay; this.dest = dest;
      this.offCanvas = new OffscreenCanvas(80, 45);
      this.offCtx = this.offCanvas.getContext("2d")!;
      this.timer = setInterval(() => this._tick(), WINDOW_MS);
      return dest;
    } catch { return null; }
  }

  private _tick() {
    if (!this.analyser || !this.videoEl) return;
    this.analyser.getByteFrequencyData(this.freqData);
    const rms = Math.sqrt(this.freqData.reduce((s, v) => s + v * v, 0) / this.freqData.length) / 128;
    this.vuLevel = Math.min(100, rms * 100);
    let vDelta = 0;
    if (this.offCtx && !this.videoEl.paused && this.videoEl.readyState >= 2) {
      try {
        this.offCtx.drawImage(this.videoEl, 0, 0, 80, 45);
        const frame = this.offCtx.getImageData(0, 0, 80, 45);
        if (this.prevPixels) {
          let sum = 0;
          for (let i = 0; i < frame.data.length; i += 4) {
            sum += Math.abs(frame.data[i] - this.prevPixels[i])
                 + Math.abs(frame.data[i+1] - this.prevPixels[i+1])
                 + Math.abs(frame.data[i+2] - this.prevPixels[i+2]);
          }
          vDelta = sum / (frame.data.length * 0.75 * 255);
        }
        this.prevPixels = new Uint8ClampedArray(frame.data);
      } catch { /* ignore */ }
    }
    this.audioSig.push(rms); this.videoSig.push(vDelta);
    if (this.audioSig.length > BUF_LEN) this.audioSig.shift();
    if (this.videoSig.length > BUF_LEN) this.videoSig.shift();
    if (this.audioSig.length === BUF_LEN && this.audioSig.length % 50 === 0) {
      const maxLag = Math.round((MAX_DELAY * 1000) / WINDOW_MS);
      let bestLag = 0, bestCorr = -Infinity;
      for (let lag = 1; lag <= maxLag; lag++) {
        let corr = 0;
        for (let i = 0; i < BUF_LEN - lag; i++) corr += this.audioSig[i] * this.videoSig[i + lag];
        if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
      }
      const nd = Math.max(MIN_DELAY, Math.min(MAX_DELAY, bestLag * WINDOW_MS / 1000));
      this.detectedDelay = 0.85 * this.detectedDelay + 0.15 * nd;
      if (this.delayNode) this.delayNode.delayTime.value = this.detectedDelay;
    }
    this.onUpdate?.(this.detectedDelay, this.vuLevel);
  }

  getMicStream() { return this.micStream; }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
    this.micStream?.getTracks().forEach(t => t.stop()); this.micStream = null;
    this.dest = null; this.delayNode = null; this.analyser = null;
    this.audioSig = []; this.videoSig = []; this.prevPixels = null;
  }
}

// ─── Voice cloning engine ─────────────────────────────────────────────────────
// Records mic in 2-second chunks, transforms each chunk via the voice API,
// plays the result back delayed to match video output.

class VoiceCloningEngine {
  private recorder:   MediaRecorder | null = null;
  private audioCtx:   AudioContext  | null = null;
  private nextPlayAt = 0;
  private running    = false;
  private videoDelay = 0.8;
  private analyserCtx: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private outDest: MediaStreamAudioDestinationNode | null = null;
  private monitorGain: GainNode | null = null;
  private monitored = false;

  call    = null as null | ((path: string, body: FormData) => Promise<Response>);
  voiceId = BUILTIN_VOICES[0].id;
  onVu?:   (level: number) => void;
  onError?: (msg: string) => void;

  setVideoDelay(d: number) { this.videoDelay = d; }

  // Send the cloned voice to the local speakers as well as the cable. Loudspeakers
  // + open mic can feed it back into the call; headphones are always safe.
  setMonitor(on: boolean) {
    if (on === this.monitored) return;
    this.monitored = on;
    if (!this.audioCtx) return;
    if (on) {
      if (!this.outDest) return;
      if (!this.monitorGain) {
        this.monitorGain = this.audioCtx.createGain();
        this.outDest.connect(this.monitorGain);
      }
      this.monitorGain.connect(this.audioCtx.destination);
    } else if (this.monitorGain) {
      this.monitorGain.disconnect(this.audioCtx.destination);
    }
  }

  async start(micStream: MediaStream) {
    if (this.running) return;
    this.running  = true;
    this.audioCtx = new AudioContext();
    this.outDest  = this.audioCtx.createMediaStreamDestination();
    this.nextPlayAt = this.audioCtx.currentTime + this.videoDelay + 0.1;

    // Analyser for waveform — uses the same mic stream
    this.analyserCtx = new AudioContext();
    const src = this.analyserCtx.createMediaStreamSource(micStream);
    this.analyserNode = this.analyserCtx.createAnalyser();
    this.analyserNode.fftSize = 256;
    src.connect(this.analyserNode);

    const chunkMs = 2000;
    const chunks: Blob[] = [];
    this.recorder = new MediaRecorder(micStream, { mimeType: "audio/webm;codecs=opus" });

    this.recorder.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data); };
    this.recorder.onstop = async () => {
      if (!this.running) return;
      const blob = new Blob(chunks.splice(0), { type: "audio/webm" });
      void this._process(blob);
      if (this.running) {
        this.recorder!.start(chunkMs);
        setTimeout(() => { if (this.running && this.recorder?.state === "recording") this.recorder.requestData(); }, chunkMs);
      }
    };
    this.recorder.start(chunkMs);
    setTimeout(() => { if (this.running && this.recorder?.state === "recording") this.recorder.requestData(); }, chunkMs);
  }

  private async _process(blob: Blob) {
    if (!this.running || !this.audioCtx || !this.call || !this.voiceId) return;
    try {
      const form = new FormData();
      form.append("audio", blob, "chunk.webm");
      form.append("model_id", "eleven_multilingual_sts_v2");
      form.append("voice_settings", JSON.stringify({ stability: 0.5, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true }));
      const res = await this.call(`/v1/speech-to-speech/${this.voiceId}/stream`, form);
      if (!res.ok) { console.warn(`[voice] engine returned HTTP ${res.status}`); this.onError?.(endReasonMessage("upstream_key")); return; }
      const buf = await res.arrayBuffer();
      if (!this.running || !this.audioCtx) return;
      const decoded = await this.audioCtx.decodeAudioData(buf);
      const playAt = Math.max(this.audioCtx.currentTime + this.videoDelay, this.nextPlayAt);
      const src = this.audioCtx.createBufferSource();
      src.buffer = decoded; src.connect(this.outDest!); src.start(playAt);
      this.nextPlayAt = playAt + decoded.duration;
      const data = decoded.getChannelData(0);
      let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      this.onVu?.(Math.min(100, Math.sqrt(sum / data.length) * 300));
    } catch (e) {
      if (this.running) this.onError?.(toUserMessage(e, "Voice processing error"));
    }
  }

  getAnalyser(): AnalyserNode | null { return this.analyserNode; }

  getOutputStream(): MediaStream | null { return this.outDest?.stream ?? null; }

  stop() {
    this.running = false;
    this.outDest = null;
    this.monitorGain = null; this.monitored = false;
    try { this.recorder?.stop(); } catch { /* ignore */ }
    this.recorder = null;
    try { this.audioCtx?.close(); } catch { /* ignore */ }
    try { this.analyserCtx?.close(); } catch { /* ignore */ }
    this.audioCtx = null; this.analyserCtx = null; this.analyserNode = null;
  }
}

// ─── Waveform canvas component ────────────────────────────────────────────────
function Waveform({ analyser, color = C, height = 80 }: { analyser: AnalyserNode | null; color?: string; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "hsl(222 47% 5%)";
      ctx.fillRect(0, 0, W, H);

      if (!analyser) {
        // idle flat line
        ctx.strokeStyle = "hsl(222 40% 20%)";
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
        return;
      }

      const buf = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(buf);

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      const step = W / buf.length;
      for (let i = 0; i < buf.length; i++) {
        const y = ((buf[i] / 128) - 1) * (H / 2 - 8) + H / 2;
        i === 0 ? ctx.moveTo(i * step, y) : ctx.lineTo(i * step, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    draw();
    return () => { cancelAnimationFrame(rafRef.current); };
  }, [analyser, color]);

  return (
    <canvas ref={canvasRef} width={600} height={height}
      style={{ width: "100%", height, borderRadius: 8, display: "block", background: "hsl(222 47% 5%)", border: "1px solid hsl(222 40% 12%)" }} />
  );
}

// ─── Voice upload helper ──────────────────────────────────────────────────────
// Voice-library work needs no lease, so it goes through the gateway with no sessionId.
/** The gateway answers refusals with { error, reason }; the reason is the part the user can act on. */
async function gatewayMessage(res: Response, fallback: string): Promise<string> {
  const j = await res.json().catch(() => null) as { error?: string; reason?: string } | null;
  if (j?.reason) return endReasonMessage(j.reason);
  return toUserMessage(j?.error ?? "", fallback);
}

async function uploadVoice(name: string, file: File): Promise<SavedVoice> {
  const form = new FormData();
  form.append("name", name);
  form.append("files", file);
  form.append("description", `Uploaded via ${APP}`);
  const res = await gateway.voice("/v1/voices/add", form);
  if (!res.ok) throw new Error(await gatewayMessage(res, "Voice upload failed"));
  const data = await res.json() as { voice_id: string };
  return { id: data.voice_id, name, createdAt: Date.now() };
}

// ─── Video engine (proven — DO NOT MODIFY) ───────────────────────────────────
const _RELAY_APP   = "decart/lucy-2-5/realtime";
const _RELAY_WS    = `wss://fal.run/${_RELAY_APP}`;

interface VideoSession { close(): void; send(d: Record<string, unknown>): void; }

type VcamResult = { supported: boolean; active: boolean; ready: boolean; error: string | null };
interface ElectronAPI {
  getDeviceId?: () => Promise<string>;
  checkForUpdate?: () => void;
  vcamStart?: () => Promise<VcamResult>;
  vcamStop?: () => Promise<VcamResult>;
  vcamStatus?: () => Promise<VcamResult & { cameraName: string }>;
  vcamFrame?: (buf: ArrayBuffer, w: number, h: number) => void;
}
function getElectronAPI(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

async function _startVideoSession(token: string, localStream: MediaStream, onRemote: (s: MediaStream) => void, onConnectionState: (state: RTCPeerConnectionState) => void, onDisconnect: () => void, prompt: string, refB64: string | null): Promise<VideoSession> {
  const ws = new WebSocket(`${_RELAY_WS}?fal_jwt_token=${encodeURIComponent(token)}&max_buffering=8`);
  ws.binaryType = "arraybuffer";
  const send = (o: Record<string, unknown>) => { if (ws.readyState === WebSocket.OPEN) ws.send(encode(o)); };
  const pp: Record<string, unknown> = { prompt };
  if (refB64) pp.reference_image_url = `data:image/jpeg;base64,${refB64}`;
  return new Promise<VideoSession>((resolve, reject) => {
    let pc: RTCPeerConnection | null = null;
    let settled = false;
    const buf: RTCIceCandidateInit[] = [];
    let hasAnswer = false;
    let to: ReturnType<typeof setTimeout> | undefined;
    // Every failure path MUST close the socket and drop its handlers. Otherwise a
    // slow server reply arriving after we gave up would still build a peer
    // connection and start a billed fal session that nothing holds a handle to
    // (a "ghost" session that drains balance until the app quits).
    const abort = (err: Error) => {
      if (settled) return;
      settled = true;
      if (to) clearTimeout(to);
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch { /**/ }
      try { pc?.close(); } catch { /**/ }
      reject(err);
    };
    to = setTimeout(() => abort(new Error(`${APP}: connection timed out`)), 30_000);
    ws.onopen = () => { send(pp); };
    ws.onmessage = async (ev) => {
      let msg: Record<string, unknown>;
      try { const d = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data; msg = decode(d) as Record<string, unknown>; } catch { return; }
      const type = (msg.type as string | undefined)?.toLowerCase();
      if ((type === "ready" || type === "iceservers") && !pc) {
        const ice = ((msg.iceServers ?? msg.ice_servers ?? msg.iceservers) as RTCIceServer[] | undefined) ?? [{ urls: "stun:stun.l.google.com:19302" }];
        pc = new RTCPeerConnection({ iceServers: ice });
        localStream.getTracks().forEach(t => pc!.addTrack(t, localStream));
        pc.ontrack = ev => { onRemote(ev.streams[0] ?? new MediaStream([ev.track])); };
        pc.onicecandidate = ev => { if (ev.candidate) send({ type: "candidate", candidate: ev.candidate.toJSON() }); };
        pc.onconnectionstatechange = () => { const st = pc?.connectionState; if (st) onConnectionState(st); };
        const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
        send({ type: "offer", sdp: pc.localDescription!.sdp, ...pp });
      } else if (type === "answer" && typeof msg.sdp === "string" && pc && !hasAnswer) {
        hasAnswer = true;
        await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: msg.sdp }));
        for (const c of buf.splice(0)) await pc.addIceCandidate(new RTCIceCandidate(c));
        if (!settled) { settled = true; if (to) clearTimeout(to); resolve({ close: () => { try { ws.close(); } catch { /**/ } try { pc?.close(); } catch { /**/ } }, send: d => send(d) }); }
      } else if ((type === "candidate" || type === "icecandidate") && msg.candidate && pc) {
        const c = msg.candidate as RTCIceCandidateInit;
        if (!hasAnswer) buf.push(c); else if (c.candidate) await pc.addIceCandidate(new RTCIceCandidate(c));
      } else if (type === "error") {
        const detail = msg.message ?? msg.reason ?? msg.error ?? "Unknown error";
        abort(new Error(`${APP} error: ${detail}`));
      }
    };
    ws.onerror = () => abort(new Error(`${APP}: connection error`));
    ws.onclose = ev => {
      if (!settled) abort(new Error(`${APP}: connection closed (${ev.code})`));
      else if (ev.code !== 1000) onDisconnect();
    };
  });
}

// ─── Cable discovery by acoustic loopback (label-free, groupId-free) ────────
// Chromium hides the VB-Cable render endpoint's label and gives its input and
// output different groupIds, so neither names nor groups identify it. But the
// cable is a loopback pair: audio played INTO its render endpoint comes OUT of
// its capture endpoint. So we play a probe tone into each unlabeled output and
// watch the cable capture inputs for level; the output that is heard is the
// cable. This needs no labels and cannot pick the wrong device.
async function _measurePeak(an: AnalyserNode, ms: number): Promise<number> {
  const buf = new Uint8Array(an.fftSize);
  let mx = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    an.getByteTimeDomainData(buf as Uint8Array<ArrayBuffer>);
    for (let i = 0; i < buf.length; i++) { const d = Math.abs(buf[i] - 128); if (d > mx) mx = d; }
    await new Promise(r => setTimeout(r, 40));
  }
  return mx;
}

async function _loopbackPick(cands: MediaDeviceInfo[], inputs: MediaDeviceInfo[]): Promise<MediaDeviceInfo | null> {
  if (!cands.length) return null;
  type Tap = { an: AnalyserNode; ctx: AudioContext };
  const taps: Tap[] = [];
  for (const inp of inputs.slice(0, 4)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: inp.deviceId } } });
      const ctx = new AudioContext();
      const an = ctx.createAnalyser(); an.fftSize = 1024;
      ctx.createMediaStreamSource(s).connect(an);
      taps.push({ an, ctx });
    } catch { /* skip unusable input */ }
  }
  if (!taps.length) return null;
  let winner: MediaDeviceInfo | null = null;
  for (const c of cands) {
    let ctx: AudioContext | null = null;
    let osc: OscillatorNode | null = null;
    try {
      ctx = new AudioContext();
      const sink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (typeof sink.setSinkId !== "function") break;
      await sink.setSinkId(c.deviceId);
      osc = ctx.createOscillator(); osc.frequency.value = 440;
      const g = ctx.createGain(); g.gain.value = 0.6;
      osc.connect(g); g.connect(ctx.destination);
      const base = await Promise.all(taps.map(t => _measurePeak(t.an, 150)));
      osc.start();
      const live = await Promise.all(taps.map(t => _measurePeak(t.an, 500)));
      osc.stop(); osc = null;
      if (live.some((v, i) => v > 24 && v > base[i] + 12)) { winner = c; break; }
    } catch { /* candidate unusable; try next */ }
    finally { try { osc?.stop(); } catch { /**/ } try { void ctx?.close(); } catch { /**/ } }
  }
  taps.forEach(t => { try { void t.ctx.close(); } catch { /**/ } });
  return winner;
}

// ─── Second video pipeline (trial accounts) ─────────────────────────────────
// Same job as _startVideoSession, but the peer connection and its signalling live
// inside the pipeline's own SDK. Everything the rest of this page needs — a remote
// MediaStream, an RTCPeerConnectionState-shaped callback, close(), send() — is
// rebuilt here from the SDK's events, so the pump that feeds the virtual camera,
// the prompt updates and the teardown code never learn there is more than one
// engine. The one rule: nothing here may put a provider name on the screen.
async function _startTrialVideoSession(
  token: string, localStream: MediaStream, onRemote: (s: MediaStream) => void,
  onConnectionState: (state: RTCPeerConnectionState) => void, onDisconnect: () => void,
  prompt: string, refB64: string | null,
): Promise<VideoSession> {
  const sdk = await import("@decartai/sdk");
  // "connecting" and "generating" are both a live picture; only the two broken
  // states may start the app's grace window, so anything unknown maps to idle.
  const stateOf = (s: string): RTCPeerConnectionState =>
    s === "connected" || s === "generating" ? "connected"
      : s === "disconnected" || s === "reconnecting" ? "disconnected"
        : "connecting";

  const client = sdk.createDecartClient({ apiKeyProvider: async () => token });
  // connect() cannot be cancelled, and giving up on it is the expensive case: the
  // pipeline still opens on the far side and keeps running with no handle anywhere
  // in this app, so it consumes trial credits until the process quits. `givenUp`
  // hands the late arrival to whoever closes it.
  type Opened = { client: import("@decartai/sdk").RealTimeClient } | { err: unknown };
  let givenUp = false;
  const opened = await new Promise<Opened>((resolve) => {
    const to = setTimeout(() => { givenUp = true; resolve({ err: `${APP}: connection timed out` }); }, 45_000);
    client.realtime.connect(localStream, {
      model: sdk.models.realtime("lucy-2.5"),
      initialState: {
        // enhance stays off: the style prompt is written to be taken literally,
        // and a server-side rewrite would make the two pipelines behave apart.
        prompt: { text: prompt, enhance: false },
        ...(refB64 ? { image: `data:image/jpeg;base64,${refB64}` } : {}),
      },
      onRemoteStream: (stream: MediaStream) => onRemote(stream),
      onConnectionChange: (state: string) => { console.info("[video] transport:", state); onConnectionState(stateOf(state)); },
    }).then(
      (c) => {
        clearTimeout(to);
        if (givenUp) { try { c.disconnect(); } catch { /**/ } resolve({ err: `${APP}: connection timed out` }); return; }
        resolve({ client: c });
      },
      (e) => { clearTimeout(to); resolve({ err: e }); },
    );
  });
  if ("err" in opened) {
    // The SDK's own wording names the service and its hostnames. That belongs in
    // the console, never on the screen, so everything becomes our prefixed
    // sentence — which toUserMessage recognises and replaces with a plain one.
    console.warn("[video] could not start the call:", opened.err);
    throw new Error(`${APP}: could not start the call`);
  }
  const rc = opened.client;

  // Only a session the server finished on purpose may end the call. A "error" event
  // is the engine reporting trouble while keeping the room open and retrying, and
  // treating it as a hang-up turned a recoverable blip into a dead stream a few
  // seconds into the trial. Both are logged with their reason, because nothing here
  // is allowed to put a provider name on the screen and a silent teardown cannot be
  // diagnosed afterwards.
  rc.on("sessionEnded", (e: { reason?: string } | undefined) => {
    console.warn("[video] the call ended:", e?.reason ?? "no reason given");
    onDisconnect();
  });
  rc.on("error", (e: unknown) => console.warn("[video] engine reported a problem:", e));

  return {
    close: () => { try { rc.disconnect(); } catch { /**/ } },
    send: (d) => {
      const p = d.prompt;
      const img = d.reference_image_url;
      if (typeof p === "string") void rc.setPrompt(p).catch(() => { /**/ });
      if (typeof img === "string") void rc.setImage(img).catch(() => { /**/ });
    },
  };
}

function _updatePrompt(session: VideoSession, prompt: string, refB64?: string | null) {
  try { session.send({ prompt, ...(refB64 ? { reference_image_url: `data:image/jpeg;base64,${refB64}` } : {}) }); } catch { /**/ }
}

function _getBaseUrl() { return window.location.href.split("#")[0]; }
function _notifyPopup(w: Window | null) { if (w && !w.closed) try { w.postMessage({ type: "stream-live-stream" }, "*"); } catch { /**/ } }

// ─────────────────────────────────────────────────────────────────────────────
//  Main component
// ─────────────────────────────────────────────────────────────────────────────
export default function StreamPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const account = useAccount();

  // ── Tab state ──────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabId>("video-audio");

  // ── Portrait / Landscape mode (persisted) ──────────────────────────────────
  const [portraitMode, setPortraitMode] = useState<boolean>(() => {
    try { return localStorage.getItem("ss_portrait_mode") === "1"; } catch { return false; }
  });
  const togglePortrait = useCallback(() => {
    setPortraitMode(v => { const next = !v; try { localStorage.setItem("ss_portrait_mode", next ? "1" : "0"); } catch { /**/ } return next; });
  }, []);

  // ── Stream state ───────────────────────────────────────────────────────────
  const [connStatus, setConnStatus]   = useState<"idle"|"connecting"|"connected"|"reconnecting">("idle");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStarting, setIsStarting]  = useState(false);
  const [isClosing, setIsClosing]    = useState(false);
  const [connStep, setConnStep]       = useState<"auth"|"engine"|null>(null);
  const [elapsed, setElapsed]         = useState(0);

  // ── Devices ───────────────────────────────────────────────────────────────
  const [cameras, setCameras]             = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics]                   = useState<MediaDeviceInfo[]>([]);
  // Per-tab: each tab keeps its own camera/mic selection (strict tab isolation).
  const [selectedCamId, setSelectedCamId] = usePerTabState<string>(activeTab, "");
  const [selectedMicId, setSelectedMicId] = usePerTabState<string>(activeTab, "");
  const [cameraReady, setCameraReady]     = useState(false);

  // ── Video style ───────────────────────────────────────────────────────────
  // Per-tab: prompt/style/reference image uploaded in one tab must not appear in another.
  const [selectedStyle, setSelectedStyle] = usePerTabState<StyleId>(activeTab, "hyper-real");
  const [customPrompt, setCustomPrompt]   = usePerTabState<string>(activeTab, "");
  const [refImageB64, setRefImageB64]     = usePerTabState<string|null>(activeTab, null);
  const [refImagePreview, setRefImagePreview] = usePerTabState<string|null>(activeTab, null);

  // ── Audio sync ────────────────────────────────────────────────────────────
  const [syncDelay, setSyncDelay]     = useState(0.8);
  const [vuLevel, setVuLevel]         = useState(0);
  const [audioActive, setAudioActive] = useState(false);

  // ── Noise cancellation (persisted, default ON) ────────────────────────────
  const [noiseCancel, setNoiseCancel] = useState<boolean>(() => {
    try { return localStorage.getItem("ss_noise_cancel") !== "0"; } catch { return true; }
  });
  const toggleNoiseCancel = useCallback(() => {
    setNoiseCancel(v => { const next = !v; try { localStorage.setItem("ss_noise_cancel", next ? "1" : "0"); } catch { /**/ } return next; });
  }, []);

  // ── Voice cloning ─────────────────────────────────────────────────────────
  // Per-tab: voice-clone toggle/voice chosen in the Audio Call tab must not leak
  // into the Video+Audio tab's audio section (and vice versa).
  const [vcEnabled, setVcEnabled]         = usePerTabState<boolean>(activeTab, false);
  const [vcActive, setVcActive]           = useState(false);
  const [vcVu, setVcVu]                   = useState(0);
  const [vcVoiceId, setVcVoiceId]         = usePerTabState<string>(activeTab, BUILTIN_VOICES[0].id);
  const [savedVoices, setSavedVoices]     = useState<SavedVoice[]>(() => getSavedVoices());
  const [uploadingVoice, setUploadingVoice] = useState(false);
  const [uploadVoiceName, setUploadVoiceName] = useState("");
  const [vcAnalyser, setVcAnalyser]       = useState<AnalyserNode | null>(null);
  const [micAnalyser, setMicAnalyser]     = useState<AnalyserNode | null>(null);

  // ── Local monitor: hear your own cloned voice ─────────────────────────────
  const [voiceMonitor, setVoiceMonitor] = useState<boolean>(() => {
    try { return localStorage.getItem("ss_voice_monitor") !== "0"; } catch { return true; }
  });
  const toggleVoiceMonitor = useCallback(() => {
    setVoiceMonitor(v => { const next = !v; try { localStorage.setItem("ss_voice_monitor", next ? "1" : "0"); } catch { /**/ } return next; });
  }, []);

  // ── UI ────────────────────────────────────────────────────────────────────
  const [isFullscreen, setIsFullscreen]       = useState(false);
  const [isPopoutOpen, setIsPopoutOpen]       = useState(false);
  const [isObsModeActive, setIsObsModeActive] = useState(false);
  const [obsInstructions, setObsInstructions] = useState(false);
  const [isObsPortraitActive, setIsObsPortraitActive] = useState(false);
  const [obsPortraitInstructions, setObsPortraitInstructions] = useState(false);

  // ── Virtual devices (Stream Live Camera / Microphone) ───────────────────
  const [vcamEnabled, setVcamEnabled]     = useState(false);
  const [vcamSupported, setVcamSupported] = useState(true);
  const [vcamReady, setVcamReady]         = useState(false);
  const [audioRouteOn, setAudioRouteOn]   = useState(false);
  const [cableSinkLabel, setCableSinkLabel] = useState("");
  // Manual override for the audio sink: the VB-Cable endpoint can appear with a
  // hidden label (permissions/runtime), so name-matching alone is unreliable.
  // The user can pin the exact output device here; persisted across sessions.
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [manualSinkId, setManualSinkId] = useState<string>(() => {
    try { return localStorage.getItem("ss_audio_sink") || ""; } catch { return ""; }
  });
  const chooseManualSink = useCallback((id: string) => {
    setManualSinkId(id);
    try { localStorage.setItem("ss_audio_sink", id); } catch { /**/ }
  }, []);
  const refreshAudioOutputs = useCallback(async () => {
    try { setAudioOutputs((await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audiooutput")); } catch { /**/ }
  }, []);
  useEffect(() => {
    refreshAudioOutputs();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshAudioOutputs);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshAudioOutputs);
  }, [refreshAudioOutputs]);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const localVideoRef   = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef  = useRef<HTMLVideoElement | null>(null);
  // Plays the cloned voice; routed to the same output as the AI video.
  const cloneAudioRef   = useRef<HTMLAudioElement | null>(null);
  const localStreamRef  = useRef<MediaStream|null>(null);
  const videoSessionRef = useRef<VideoSession|null>(null);
  // Open lease id: heartbeat/endCall live on the gateway, this mirrors it for cleanup.
  const sessionIdRef    = useRef<string|null>(null);
  // Monotonic session generation. A socket that dies late (a previous attempt's
  // ghost) must not tear down the session the user is watching now.
  const sessionGenRef = useRef(0);
  // Grace timer for a WebRTC "failed" state: the connection can recover on its
  // own (Wi-Fi roams), so we wait a beat before tearing the call down.
  const iceGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncPipeRef     = useRef<AudioSyncPipeline|null>(null);
  const clonerRef       = useRef<VoiceCloningEngine|null>(null);
  const timerRef        = useRef<ReturnType<typeof setInterval>|null>(null);
  const popoutRef       = useRef<Window|null>(null);
  const obsWindowRef    = useRef<Window|null>(null);
  const obsPortraitWindowRef = useRef<Window|null>(null);
  const remoteStreamRef = useRef<MediaStream|null>(null);
  const isStartingRef   = useRef(false);
  const closingRef      = useRef(false);
  // Live-camera restart handles used by enumerateDevices auto-correct.
  const startCameraRef   = useRef<((deviceId?: string) => Promise<void>) | null>(null);
  const cameraReadyRef   = useRef(false);
  // Virtual-camera frame pump handles.
  const vcamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const vcamTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vcamOnRef     = useRef(false);
  // Mic-only analyser for audio-only tab waveform
  const micOnlyAudioCtxRef  = useRef<AudioContext|null>(null);
  const micOnlyAnalyserRef  = useRef<AnalyserNode|null>(null);
  const micOnlyStreamRef    = useRef<MediaStream|null>(null);

  const credsMissing = !account.signedIn || !hasMinutes(account, modalityForTab(activeTab));
  const voiceKeySet  = account.signedIn && hasMinutes(account, modalityForTab(activeTab));

  // A new account holds one thing: the free video minute. Dropping it on the
  // video+audio tab would open the app on a bucket the customer has never had and
  // cannot fill from a trial, so when video is the only funded bucket, the tab
  // follows the wallet. Once per sign-in — after that the choice is theirs.
  const trialTabRouted = useRef(false);
  useEffect(() => {
    if (trialTabRouted.current || account.loading || !account.signedIn || account.wallets.length === 0) return;
    trialTabRouted.current = true;
    if (hasMinutes(account, "video") && !hasMinutes(account, "audio") && !hasMinutes(account, "video_audio")) {
      setActiveTab("video-only");
    }
  }, [account]);

  // ─── All voices merged ─────────────────────────────────────────────────────
  const allVoices = [...savedVoices.map(v => ({ id: v.id, name: `★ ${v.name}` })), ...BUILTIN_VOICES];

  // ─── Enumerate devices ─────────────────────────────────────────────────────
  const enumerateDevices = useCallback(async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const allVids = devs.filter(d => d.kind === "videoinput");
      const allAuds = devs.filter(d => d.kind === "audioinput");
      // Prefer real hardware; keep unlabeled (pre-permission) devices so the
      // list isn't empty before the user grants camera access. Only fall back
      // to the unfiltered list if filtering would leave nothing.
      const realVids = allVids.filter(d => !d.label || !isVirtualCamLabel(d.label));
      const realAuds = allAuds.filter(d => !d.label || !isVirtualMicLabel(d.label));
      const vids = realVids.length ? realVids : allVids;
      const auds = realAuds.length ? realAuds : allAuds;
      setCameras(vids); setMics(auds);

      // Default selection to a real device.
      if (vids.length && !selectedCamId) setSelectedCamId(vids[0].deviceId);
      if (auds.length && !selectedMicId) setSelectedMicId(auds[0].deviceId);

      // Auto-correct a currently-selected virtual device (e.g. an OBS Virtual
      // Camera left over from a prior install) and restart the live preview on
      // a real camera so the feed isn't permanently black.
      const camStillListed = !selectedCamId || vids.some(v => v.deviceId === selectedCamId);
      if (!camStillListed && vids.length) {
        const nextId = vids[0].deviceId;
        setSelectedCamId(nextId);
        if (cameraReadyRef.current) startCameraRef.current?.(nextId);
      }
      if (selectedMicId && !auds.some(a => a.deviceId === selectedMicId) && auds.length) {
        setSelectedMicId(auds[0].deviceId);
      }
    } catch { /* ignore */ }
  }, [selectedCamId, selectedMicId]);

  useEffect(() => { enumerateDevices(); }, []);

  // ─── Tab switch: stop stream first ─────────────────────────────────────────
  const switchTab = useCallback((tab: TabId) => {
    if (isStreaming || isStarting) {
      teardownStream();
      toast({ title: "Stream stopped", description: "Switching modes." });
    }
    setActiveTab(tab);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, isStarting]);

  // ─── Camera ────────────────────────────────────────────────────────────────
  const startCamera = useCallback(async (deviceId?: string) => {
    const id = deviceId ?? selectedCamId;
    const constraints = (exact: boolean): MediaStreamConstraints => ({
      video: id && exact
        ? { deviceId: { exact: id }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    try {
      // Acquire the NEW stream before tearing down the old one, so a failed
      // getUserMedia never leaves the preview permanently black. If the exact
      // device id is gone (unplugged / virtual device removed), retry without it.
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints(true));
      } catch {
        stream = await navigator.mediaDevices.getUserMedia(constraints(false));
      }
      localStreamRef.current?.getTracks().forEach(t => t.stop());
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      cameraReadyRef.current = true;
      setCameraReady(true); enumerateDevices();
    } catch { toast({ title: "Camera Error", description: "Could not access camera.", variant: "destructive" }); }
  }, [selectedCamId, enumerateDevices, toast]);

  // Refs so enumerateDevices can restart the live camera without a dep cycle.
  startCameraRef.current = startCamera;

  // ─── Turn camera OFF (release hardware, clear preview) ───────────────────────
  const stopCamera = useCallback(() => {
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    cameraReadyRef.current = false;
    setCameraReady(false);
  }, []);

  const handleCameraSwitch = useCallback(async (id: string) => {
    if (id === selectedCamId) return;
    setSelectedCamId(id);
    if (cameraReady) {
      // Release the previously-selected camera immediately, then start the new one.
      localStreamRef.current?.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      await startCamera(id);
    }
  }, [cameraReady, selectedCamId, startCamera]);

  // Strict tab isolation: release the camera whenever the active tab changes, so
  // a camera turned on in one tab never keeps showing in another. Each tab starts
  // with its preview off until the user enables it there.
  useEffect(() => { stopCamera(); }, [activeTab, stopCamera]);

  // ─── Virtual camera: pump AI output frames to the native feeder ─────────────
  // Draws the AI output video into a fixed 1280x720 RGBA8 canvas and pushes each
  // frame over IPC to the Electron main process, which writes it into the
  // "Stream Live Camera" shared-memory buffer. resizemode=LINEAR in the header
  // makes the filter scale to whatever resolution the calling app negotiated.
  const VCAM_W = 1280, VCAM_H = 720;
  const vcamTick = useCallback(() => {
    if (!vcamOnRef.current) return;
    const api = getElectronAPI();
    let canvas = vcamCanvasRef.current;
    if (!canvas) { canvas = document.createElement("canvas"); vcamCanvasRef.current = canvas; }
    if (canvas.width !== VCAM_W) canvas.width = VCAM_W;
    if (canvas.height !== VCAM_H) canvas.height = VCAM_H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      const v = remoteVideoRef.current;
      if (v && v.videoWidth > 0 && v.readyState >= 2) {
        const vr = v.videoWidth / v.videoHeight, cr = VCAM_W / VCAM_H;
        let dw = VCAM_W, dh = VCAM_H, dx = 0, dy = 0;
        if (vr > cr) { dh = VCAM_H; dw = VCAM_H * vr; dx = (VCAM_W - dw) / 2; }
        else         { dw = VCAM_W; dh = VCAM_W / vr; dy = (VCAM_H - dh) / 2; }
        ctx.drawImage(v, dx, dy, dw, dh);
      } else {
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, VCAM_W, VCAM_H);
      }
      const frame = ctx.getImageData(0, 0, VCAM_W, VCAM_H);
      api?.vcamFrame?.(frame.data.buffer as ArrayBuffer, VCAM_W, VCAM_H);
    }
    vcamTimerRef.current = setTimeout(vcamTick, 33); // ~30fps
  }, []);

  const stopVCamPump = useCallback(() => {
    vcamOnRef.current = false;
    if (vcamTimerRef.current) { clearTimeout(vcamTimerRef.current); vcamTimerRef.current = null; }
  }, []);

  const toggleVCam = useCallback(async () => {
    const api = getElectronAPI();
    if (!api?.vcamStart || !api?.vcamStop) {
      setVcamSupported(false);
      toast({ title: "Virtual camera unavailable", description: "Run in the Stream Live desktop app on Windows, and install the Stream Live Camera driver.", variant: "destructive" });
      return;
    }
    if (!vcamEnabled) {
      const r = await api.vcamStart();
      setVcamSupported(r.supported);
      if (!r.supported) {
        toast({ title: "Virtual camera unavailable", description: r.error || "The native driver layer could not load.", variant: "destructive" });
        return;
      }
      setVcamEnabled(true);
      vcamOnRef.current = true;
      vcamTick();
      toast({ title: "Stream Live Camera ON", description: "Select “Stream Live Camera” in Zoom/Teams/Chrome. It shows the AI output while streaming." });
    } else {
      stopVCamPump();
      await api.vcamStop();
      setVcamEnabled(false);
      setVcamReady(false);
    }
  }, [vcamEnabled, vcamTick, stopVCamPump, toast]);

  // Poll native readiness (true once a calling app has opened the camera).
  useEffect(() => {
    if (!vcamEnabled) return;
    let alive = true;
    const iv = setInterval(async () => {
      const st = await getElectronAPI()?.vcamStatus?.();
      if (alive && st) { setVcamReady(st.ready); setVcamSupported(st.supported); }
    }, 1000);
    return () => { alive = false; clearInterval(iv); };
  }, [vcamEnabled]);

  // Always tear the feeder down on unmount.
  useEffect(() => () => { stopVCamPump(); getElectronAPI()?.vcamStop?.(); }, [stopVCamPump]);

  // ─── Virtual microphone: route AI audio to the VB-Cable sink ────────────────
  // Output-device labels are blank until the page holds a media permission, so we
  // request one (and immediately release it) before scanning for the cable.
  const ensureMediaPermission = useCallback(async (): Promise<boolean> => {
    // Output-device labels stay blank until the page holds ANY media permission.
    // The mic may be busy/denied, so fall back to video (and then both) — any
    // successful grant reveals the labels we need to find the VB-Cable sink.
    const attempts: MediaStreamConstraints[] = [
      { audio: true },
      { video: true },
      { audio: true, video: true },
    ];
    for (const c of attempts) {
      try {
        const s = await navigator.mediaDevices.getUserMedia(c);
        s.getTracks().forEach(t => t.stop());
        return true;
      } catch { /* try next */ }
    }
    return false;
  }, []);

  const findCableSink = useCallback(async (): Promise<{ id: string; label: string } | null> => {
    const scan = async (): Promise<MediaDeviceInfo[]> => {
      try { return await navigator.mediaDevices.enumerateDevices(); } catch { return []; }
    };
    const outsOf = (devs: MediaDeviceInfo[]) => devs.filter(d => d.kind === "audiooutput");
    const byLabel = (outs: MediaDeviceInfo[]) =>
      outs.find(d => CABLE_OUTPUT_RE.test(d.label)) ||
      outs.find(d => CABLE_ANY_RE.test(d.label));
    // On Windows Chromium keeps the cable's OUTPUT label "(hidden)", so label
    // matching alone can never find it. But the cable's INPUT endpoint ("CABLE
    // Output (VB-Audio Virtual Cable)") DOES get a real label once mic permission
    // is granted, and both ends share one groupId. So we find the cable by its
    // input, then jump across to the matching (hidden) output. Label-free.
    // (On macOS BlackHole is labelled normally, so the pass above already hits.)
    const byGroup = (devs: MediaDeviceInfo[]) => {
      const cableIn = devs.find(d => d.kind === "audioinput" && d.groupId &&
        CABLE_ANY_RE.test(d.label));
      if (!cableIn) return undefined;
      return outsOf(devs).find(d => d.groupId === cableIn.groupId);
    };
    try {
      let devs = await scan();
      // Input labels are hidden until a permission grant reveals them.
      if (devs.filter(d => d.kind === "audioinput").every(d => !d.label)) {
        await ensureMediaPermission();
        devs = await scan();
      }
      let hit = byLabel(outsOf(devs)) || byGroup(devs);
      // Endpoint enumeration can lag a permission grant; retry briefly.
      for (let i = 0; !hit && i < 3; i++) {
        await new Promise(r => setTimeout(r, 300));
        devs = await scan();
        hit = byLabel(outsOf(devs)) || byGroup(devs);
      }
      // Definitive, label-free fallback: probe unlabeled outputs acoustically.
      // The cable is a loopback pair, so the output whose probe tone is heard on
      // the cable capture input IS the cable. Cannot pick the wrong device.
      if (!hit) {
        const cands = outsOf(devs).filter(d => !d.label);
        if (cands.length) {
          const cableIns = devs.filter(d => d.kind === "audioinput" && CABLE_ANY_RE.test(d.label));
          const targetIns = cableIns.length ? cableIns : devs.filter(d => d.kind === "audioinput" && !d.label);
          const verified = await _loopbackPick(cands, targetIns);
          if (verified) hit = verified;
          else if (cands.length === 1 && targetIns.length === 0) hit = cands[0];
        }
      }
      return hit ? { id: hit.deviceId, label: hit.label || `${CABLE_NAME} (auto-detected)` } : null;
    } catch { return null; }
  }, [ensureMediaPermission]);

  const applyAudioRoute = useCallback(async (on: boolean) => {
    type SinkEl = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
    const els = [remoteVideoRef.current, cloneAudioRef.current].filter(Boolean) as SinkEl[];
    if (!els.length) return;
    const setSinks = async (id: string) => { for (const el of els) await el.setSinkId!(id); };
    if (!on) { for (const el of els) { try { await el.setSinkId?.(""); } catch { /* ignore */ } } setCableSinkLabel(""); return; }
    if (els.some(el => typeof el.setSinkId !== "function")) {
      toast({ title: "Audio routing unsupported", description: "This runtime can't select an output device.", variant: "destructive" });
      setAudioRouteOn(false); return;
    }
    // 1) User-pinned output device (works even when labels are hidden).
    if (manualSinkId) {
      try {
        await setSinks(manualSinkId);
        const lbl = audioOutputs.find(d => d.deviceId === manualSinkId)?.label;
        setCableSinkLabel(lbl || "Pinned output");
        return;
      } catch { /* pinned device gone; fall through to auto-detect */ }
    }
    const cable = await findCableSink();
    if (cable) {
      try {
        await setSinks(cable.id);
        setCableSinkLabel(cable.label);
        // Pin it so reconnects and re-toggles reuse the same (hidden-label) sink.
        chooseManualSink(cable.id);
        return;
      } catch { /* fall through to diagnostics */ }
    }
    // Diagnostics: report what the runtime actually sees so failures are
    // self-explanatory instead of a generic "not detected".
    let diag = "";
    try {
      const outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audiooutput");
      diag = outs.length
        ? ` Outputs seen: ${outs.map(d => d.label || "(hidden)").join(", ")}.`
        : " No audio output devices enumerated at all.";
    } catch { diag = " Could not enumerate devices."; }
    toast({
      title: "Virtual microphone not detected",
      description: IS_MAC
        ? `${CABLE_NAME} isn't visible to Stream Live.${diag} Install it from existential.audio/blackhole, log out and back in, then pick it in the “Audio out” dropdown. Steps: Settings → Mac Setup.`
        : `The VB-Audio cable output device isn't visible.${diag} Pick it manually from the “Audio out” dropdown in the Broadcast panel (choose the unlabeled / VB-Cable entry), or set “Speakers (VB-Audio Virtual Cable)” as your Windows default playback device.`,
      variant: "destructive",
    });
    setAudioRouteOn(false); return;
  }, [findCableSink, toast, manualSinkId, audioOutputs, chooseManualSink]);

  const toggleAudioRoute = useCallback(async () => {
    const next = !audioRouteOn;
    setAudioRouteOn(next);
    await applyAudioRoute(next);
    if (next && voiceMonitor && clonerRef.current) {
      toast({ title: "Local monitor is on", description: "Your cloned voice also plays in your speakers. Use headphones — loudspeakers let your mic feed it back into the call." });
    }
  }, [audioRouteOn, applyAudioRoute, voiceMonitor, toast]);

  // Re-apply routing when the AI output (re)connects, since srcObject changes,
  // and when the cloned voice stream starts (its audio element mounts then).
  useEffect(() => {
    if (audioRouteOn && connStatus === "connected") applyAudioRoute(true);
  }, [connStatus, audioRouteOn, applyAudioRoute, vcActive]);

  // While cloning, the cable must carry the persona voice only — the raw voice
  // round-tripped through the AI session is silenced on the clone tabs.
  useEffect(() => {
    const v = remoteVideoRef.current;
    if (v) v.muted = vcActive;
  }, [vcActive, connStatus]);

  // With routing OFF the clone already reaches your speakers through the audio
  // element; monitor mode only adds local playback when the clone is on the cable.
  useEffect(() => {
    clonerRef.current?.setMonitor(voiceMonitor && audioRouteOn);
  }, [voiceMonitor, audioRouteOn, vcActive]);

  // ─── Mic-only preview for audio-only tab ───────────────────────────────────
  const startMicPreview = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micAudioConstraints(selectedMicId || undefined, noiseCancel), video: false,
      });
      micOnlyStreamRef.current?.getTracks().forEach(t => t.stop());
      micOnlyStreamRef.current = stream;
      micOnlyAudioCtxRef.current?.close().catch(() => {});
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 256;
      src.connect(an);
      micOnlyAudioCtxRef.current = ctx;
      micOnlyAnalyserRef.current = an;
      setMicAnalyser(an);
    } catch { /* ignore */ }
  }, [selectedMicId, noiseCancel]);

  useEffect(() => {
    if (activeTab === "audio-only") { startMicPreview(); }
    else {
      micOnlyStreamRef.current?.getTracks().forEach(t => t.stop());
      micOnlyAudioCtxRef.current?.close().catch(() => {});
      micOnlyStreamRef.current = null; micOnlyAnalyserRef.current = null;
      setMicAnalyser(null);
    }
  }, [activeTab, startMicPreview]);

  // ─── Teardown ──────────────────────────────────────────────────────────────
  const teardownStream = useCallback(async () => {
    sessionGenRef.current++;
    if (iceGraceRef.current) { clearTimeout(iceGraceRef.current); iceGraceRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    isStartingRef.current = false;
    closingRef.current = true; setIsClosing(true);
    endLease();
    videoSessionRef.current?.close(); videoSessionRef.current = null;
    clonerRef.current?.stop(); clonerRef.current = null;
    if (cloneAudioRef.current) { try { cloneAudioRef.current.pause(); } catch { /**/ } cloneAudioRef.current.srcObject = null; }
    syncPipeRef.current?.stop(); syncPipeRef.current = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    remoteStreamRef.current = null; window.__slRemoteStream = null;
    [popoutRef, obsWindowRef, obsPortraitWindowRef].forEach(r => {
      if (r.current && !r.current.closed) try { r.current.postMessage("stream-live-clear", "*"); } catch { /**/ }
    });
    setIsStreaming(false); setConnStatus("idle"); setConnStep(null); setElapsed(0);
    setAudioActive(false); setSyncDelay(0.8); setVuLevel(0);
    setVcActive(false); setVcVu(0); setVcAnalyser(null);
    // Refund the prepaid chunk only after the call is locally dead. Waiting for
    // that round-trip first left Stop unresponsive — and an unreached one is
    // refunded by the lease expiring server-side anyway.
    sessionIdRef.current = null;
    await Promise.race([
      gateway.endCall().catch(() => {}),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    closingRef.current = false; setIsClosing(false);
    void refreshBalances();
  }, []);

  // Route changes (e.g. opening Settings mid-stream) unmount this page. Without
  // this the fal WebSocket would stay open and keep billing in the background.
  useEffect(() => { return () => { void teardownStream(); }; }, [teardownStream]);

  // ─── Stop the call when the countdown reaches zero ─────────────────────────
  // The gateway only re-prices the lease on the 45-second heartbeat, so left to
  // itself a call stays on air for up to that long after the bucket is empty: the
  // clock reads 0:00 and nothing happens until the user presses Stop. The meter
  // tells him the call stops now, so arm a timer for the second its own minutes
  // run out. A call that has not shown a frame spends nothing, so its deadline is
  // measured from the frame; and a call opened on the last sliver of change gets
  // its first few seconds rather than a drop that looks like a crash.
  useEffect(() => {
    const MIN_FUNDED_MS = 10_000;
    const lease = account.live;
    if (!isStreaming || !lease || lease.unlimited) return;
    const burn = bucketFor(account, lease.modality)?.burnRate ?? 1;
    const drain = drainOf(lease, burn, Date.now());
    if (drain.remaining === null) return;
    const airStart = lease.modality === "audio" ? lease.startedAt : (lease.mediaAt ?? lease.startedAt);
    const stopAt = Math.max(Date.now() + (drain.remaining * 60_000) / burn, airStart + MIN_FUNDED_MS);
    const id = setTimeout(() => {
      if (!sessionIdRef.current) return;
      void teardownStream();
      toast({ title: "Out of minutes", description: endReasonMessage("out_of_minutes"), variant: "destructive" });
      setLocation("/minutes");
    }, Math.max(0, stopAt - Date.now()));
    return () => clearTimeout(id);
  }, [isStreaming, account, teardownStream, toast, setLocation]);

  // ─── Start stream ──────────────────────────────────────────────────────────
  const handleStartStream = useCallback(async () => {
    if (isStartingRef.current || closingRef.current || isStreaming) return;
    const needsVideo = activeTab !== "audio-only";
    const needsVoice = activeTab !== "video-only" && vcEnabled;
    const tabName: TabName = activeTab;

    if (credsMissing) { setLocation(account.signedIn ? "/minutes" : "/account"); return; }
    if (needsVideo && (!cameraReady || !localStreamRef.current)) {
      toast({ title: "Camera not ready", description: "Enable your camera first.", variant: "destructive" }); return;
    }

    isStartingRef.current = true; setIsStarting(true); setConnStep("auth"); setConnStatus("connecting");

    try {
      // Open the metered lease first: nothing touches WebRTC until the gateway
      // confirms this account and bucket can pay for the call.
      const ticket = await gateway.startCall(tabName, await deviceId());
      sessionIdRef.current = ticket.sessionId;
      beginLease(ticket);

      setConnStep("engine");
      const style  = STYLES.find(s => s.id === selectedStyle)!;
      const prompt = customPrompt.trim() || style.prompt;

      // ── Audio sync pipeline (video tabs only) ──────────────────────────
      let sendStream = localStreamRef.current ?? new MediaStream();
      let micStreamForCloner: MediaStream | null = null;

      if (needsVideo) {
        const pipe = new AudioSyncPipeline();
        pipe.onUpdate = (delay, vu) => {
          setSyncDelay(delay); setVuLevel(vu);
          clonerRef.current?.setVideoDelay(delay);
        };
        const dest = await pipe.start(remoteVideoRef.current!, selectedMicId || undefined, noiseCancel);
        syncPipeRef.current = pipe;
        if (dest) {
          const track = dest.stream.getAudioTracks()[0];
          if (track) { sendStream = new MediaStream([...(localStreamRef.current?.getVideoTracks() ?? []), track]); setAudioActive(true); }
        }
        micStreamForCloner = pipe.getMicStream();
      }

      // ── Start video session ────────────────────────────────────────────
      // The Audio Call tab has no video token (ticket.token === null): it is
      // voice-only and must never open a video session. Which of the two pipelines
      // opens is the gateway's call, made from the account's wallet; this page only
      // obeys it, and never says it out loud.
      if (needsVideo) {
        if (!ticket.token) throw new Error(`${APP}: gateway returned no video token`);
        const gen = ++sessionGenRef.current;
        const open = ticket.engine === "decart" ? _startTrialVideoSession : _startVideoSession;
        const session = await open(
          ticket.token, sendStream,
          remote => {
            if (sessionGenRef.current !== gen) return;
            remoteStreamRef.current = remote;
            if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remote;
            window.__slRemoteStream = remote;
            _notifyPopup(popoutRef.current); _notifyPopup(obsWindowRef.current); _notifyPopup(obsPortraitWindowRef.current);
            setConnStatus("connected");
          },
          state => {
            if (sessionGenRef.current !== gen) return;
            if (state === "connected") {
              if (iceGraceRef.current) { clearTimeout(iceGraceRef.current); iceGraceRef.current = null; }
              setConnStatus("connected");
              return;
            }
            // "disconnected" / "failed" / "closed": the transport can recover on
            // Wi-Fi, so wait a short grace window before declaring the call dead —
            // but never leave it running, or minutes keep burning on a dead stream.
            // Other states (new / connecting) are normal startup and ignored here.
            if (state !== "disconnected" && state !== "failed" && state !== "closed") return;
            if (iceGraceRef.current) return;
            setConnStatus("reconnecting");
            iceGraceRef.current = setTimeout(() => {
              iceGraceRef.current = null;
              if (sessionGenRef.current !== gen) return;
              void teardownStream();
              toast({ title: "Call ended", description: endReasonMessage("connection_lost"), variant: "destructive" });
            }, 6000);
          },
          () => {
            if (sessionGenRef.current !== gen) return;
            void teardownStream();
            toast({ title: "Call ended", description: endReasonMessage("connection_lost"), variant: "destructive" });
          },
          prompt, refImageB64,
        );
        if (sessionGenRef.current !== gen) { session.close(); return; }
        videoSessionRef.current = session;
      } else {
        // Audio-only: start mic preview
        micStreamForCloner = micOnlyStreamRef.current;
        setConnStatus("connected");
      }

      // ── Start voice cloning ────────────────────────────────────────────
      if (needsVoice && (micStreamForCloner || micOnlyStreamRef.current)) {
        const cloner = new VoiceCloningEngine();
        cloner.call    = (path, body) => gateway.voice(path, body, { isStream: true, sessionId: ticket.sessionId });
        cloner.voiceId = vcVoiceId;
        cloner.setVideoDelay(syncPipeRef.current?.detectedDelay ?? 0.3);
        cloner.onVu    = v => setVcVu(v);
        cloner.onError = msg => toast({ title: "Voice engine problem", description: toUserMessage(msg, "The voice service had trouble. Try again."), variant: "destructive" });
        await cloner.start(micStreamForCloner ?? micOnlyStreamRef.current!);
        clonerRef.current = cloner;
        setVcAnalyser(cloner.getAnalyser());
        setVcActive(true);
        const out = cloner.getOutputStream();
        if (out && cloneAudioRef.current) {
          cloneAudioRef.current.srcObject = out;
          void cloneAudioRef.current.play().catch(() => {});
        }
      }

      // Heartbeat well inside the 120 s lease TTL. When it reports ended the
      // bucket has run dry: stop cleanly and tell the user to ask for a top-up.
      gateway.beginHeartbeat(state => {
        updateLease(ticket.sessionId, state);
        void refreshBalances();
        if (state.ended) {
          void teardownStream();
          const oom = state.reason === "out_of_minutes";
          toast({ title: oom ? "Out of minutes" : "Call ended", description: endReasonMessage(state.reason), variant: "destructive" });
          if (oom) setLocation("/minutes");
        }
      }, 45_000);

      const t0 = Date.now();
      timerRef.current = setInterval(() => { setElapsed(Math.floor((Date.now() - t0) / 1000)); }, 1000);
      setIsStreaming(true);

    } catch (err) {
      // teardownStream gives back any prepaid chunk, so no separate refund call.
      void teardownStream();
      if (err instanceof GatewayError) {
        const msg = endReasonMessage(err.reason);
        if (err.reason === "out_of_minutes") {
          toast({ title: "Out of minutes", description: msg, variant: "destructive" });
          setLocation("/minutes");
        } else {
          // A refused old build is the one case where we can fix it ourselves:
          // ask the updater for the banner instead of leaving him stuck on a
          // message with nowhere to go.
          if (err.reason === "update_required") getElectronAPI()?.checkForUpdate?.();
          toast({ title: "Cannot start", description: msg, variant: "destructive" });
        }
      } else {
        toast({ title: "Cannot start", description: toUserMessage(err, "Could not start the call. Please try again."), variant: "destructive" });
      }
    } finally { isStartingRef.current = false; setIsStarting(false); }
  }, [isStreaming, credsMissing, cameraReady, activeTab, selectedStyle, customPrompt, refImageB64,
      selectedMicId, vcEnabled, vcVoiceId, noiseCancel, teardownStream, toast, setLocation]);

  const handleStop = useCallback(() => teardownStream(), [teardownStream]);

  // ─── Prompt updates ────────────────────────────────────────────────────────
  const handlePromptChange = useCallback((p: string) => {
    if (videoSessionRef.current && isStreaming) _updatePrompt(videoSessionRef.current, p, refImageB64);
  }, [isStreaming, refImageB64]);

  const handleStyleSelect = useCallback((id: StyleId) => {
    setSelectedStyle(id);
    handlePromptChange(customPrompt.trim() || STYLES.find(s => s.id === id)!.prompt);
  }, [customPrompt, handlePromptChange]);

  const handleCustomPromptChange = useCallback((v: string) => {
    setCustomPrompt(v);
    if (isStreaming) handlePromptChange(v.trim() || STYLES.find(s => s.id === selectedStyle)!.prompt);
  }, [isStreaming, selectedStyle, handlePromptChange]);

  // ─── Reference image ───────────────────────────────────────────────────────
  const handleRefImage = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const r = new FileReader();
    r.onload = ev => {
      const data = ev.target?.result as string; const b64 = data.split(",")[1] ?? data;
      setRefImagePreview(data); setRefImageB64(b64);
      if (videoSessionRef.current && isStreaming) {
        _updatePrompt(videoSessionRef.current, customPrompt.trim() || STYLES.find(s => s.id === selectedStyle)!.prompt, b64);
      }
    };
    r.readAsDataURL(file); e.target.value = "";
  }, [isStreaming, selectedStyle, customPrompt, setRefImagePreview, setRefImageB64]);

  // ─── Voice upload ──────────────────────────────────────────────────────────
  const handleVoiceUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    if (!account.signedIn) { toast({ title: "Sign in required", description: "Open your account to sign in before uploading a voice.", variant: "destructive" }); return; }
    const name = uploadVoiceName.trim() || file.name.replace(/\.[^.]+$/, "");
    setUploadingVoice(true);
    try {
      const voice = await uploadVoice(name, file);
      addSavedVoice(voice);
      setSavedVoices(getSavedVoices());
      setVcVoiceId(voice.id);
      setUploadVoiceName("");
      toast({ title: "Voice uploaded!", description: `"${voice.name}" is ready to use.` });
    } catch (err) {
      toast({ title: "Upload failed", description: toUserMessage(err, "Could not upload the voice. Try again."), variant: "destructive" });
    } finally { setUploadingVoice(false); }
  }, [account.signedIn, uploadVoiceName, toast]);

  const handleDeleteVoice = useCallback((id: string) => {
    removeSavedVoice(id); setSavedVoices(getSavedVoices());
    if (vcVoiceId === id) setVcVoiceId(BUILTIN_VOICES[0].id);
  }, [vcVoiceId]);

  // ─── Popup windows ─────────────────────────────────────────────────────────
  const openPopout = useCallback(() => {
    if (popoutRef.current && !popoutRef.current.closed) { popoutRef.current.focus(); return; }
    const w = window.open(_getBaseUrl() + "#/popout", "ss-popout", "width=1280,height=720,menubar=no,toolbar=no,location=no");
    if (!w) return; popoutRef.current = w; setIsPopoutOpen(true);
    w.addEventListener("load", () => _notifyPopup(w));
    const chk = setInterval(() => { if (w.closed) { clearInterval(chk); setIsPopoutOpen(false); popoutRef.current = null; } }, 1000);
  }, []);
  const openObs = useCallback(() => {
    if (obsWindowRef.current && !obsWindowRef.current.closed) { obsWindowRef.current.focus(); return; }
    const w = window.open(_getBaseUrl() + "#/obsout", "ss-obsout", "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no");
    if (!w) return; obsWindowRef.current = w; setIsObsModeActive(true); setObsInstructions(true);
    w.addEventListener("load", () => _notifyPopup(w));
    const chk = setInterval(() => { if (w.closed) { clearInterval(chk); setIsObsModeActive(false); setObsInstructions(false); obsWindowRef.current = null; } }, 1000);
  }, []);
  const closeObs    = useCallback(() => { obsWindowRef.current?.close(); obsWindowRef.current = null; setIsObsModeActive(false); setObsInstructions(false); }, []);
  const openObsPortrait = useCallback(() => {
    if (obsPortraitWindowRef.current && !obsPortraitWindowRef.current.closed) { obsPortraitWindowRef.current.focus(); return; }
    // 9:16 portrait window for OBS window-capture (mobile-mode fallback).
    const h = 900, w = Math.round(h * 9 / 16);
    const w2 = window.open(_getBaseUrl() + "#/obsout-portrait", "ss-obsout-portrait", `width=${w},height=${h},menubar=no,toolbar=no,location=no,status=no`);
    if (!w2) return; obsPortraitWindowRef.current = w2; setIsObsPortraitActive(true); setObsPortraitInstructions(true);
    w2.addEventListener("load", () => _notifyPopup(w2));
    const chk = setInterval(() => { if (w2.closed) { clearInterval(chk); setIsObsPortraitActive(false); setObsPortraitInstructions(false); obsPortraitWindowRef.current = null; } }, 1000);
  }, []);
  const closeObsPortrait = useCallback(() => { obsPortraitWindowRef.current?.close(); obsPortraitWindowRef.current = null; setIsObsPortraitActive(false); setObsPortraitInstructions(false); }, []);
  const closePopout = useCallback(() => { popoutRef.current?.close(); popoutRef.current = null; setIsPopoutOpen(false); }, []);
  const closeAll    = useCallback(() => { closePopout(); closeObs(); closeObsPortrait(); }, [closePopout, closeObs, closeObsPortrait]);

  useEffect(() => {
    const h = (e: MessageEvent) => {
      if (e.data === "stream-live-stop") teardownStream();
      else if (e.data === "stream-live-reconnect" && cameraReady) { teardownStream(); setTimeout(() => handleStartStream(), 300); }
    };
    window.addEventListener("message", h); return () => window.removeEventListener("message", h);
  }, [teardownStream, cameraReady, handleStartStream]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isFullscreen) { teardownStream(); setIsFullscreen(false); return; }
        closeAll(); if (isStreaming) teardownStream(); return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "f" || e.key === "F") { e.preventDefault(); setIsFullscreen(v => !v); }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [isStreaming, isFullscreen, teardownStream, closeAll]);

  const curStyle = STYLES.find(s => s.id === selectedStyle)!;
  const selectSt: React.CSSProperties = { width: "100%", appearance: "none", padding: "8px 32px 8px 12px", background: "hsl(222 47% 4%)", border: "1px solid hsl(222 40% 14%)", borderRadius: 8, color: "hsl(190 80% 96%)", fontSize: 13, fontFamily: "'Rajdhani',sans-serif", cursor: "pointer", opacity: isStreaming ? 0.5 : 1 };
  const needsVideo = activeTab !== "audio-only";
  const needsVoice = activeTab !== "video-only";

  // ─── Video output panel (portrait & landscape) ────────────────────────────
  // Portrait mode = 9:16 ratio, clean output, no overlay chrome.
  // Landscape mode = 16:9 ratio, OBS/popout buttons visible.
  // The mode toggle sits OUTSIDE the panel so the video output is always clean.
  // Render function (NOT a nested component): returning the JSX inline keeps the
  // <video> element's identity stable across re-renders, so React reuses the same
  // DOM node instead of remounting it. A nested component gets a new type identity
  // every render, which unmounts the <video> and drops its srcObject → black frame.
  const renderVideoOutput = (showPiP: boolean = true) => {
    const isPortrait = portraitMode;
    const panelStyle: React.CSSProperties = isPortrait
      ? {
          // 9:16 — exact mobile phone video call ratio
          // Centred, max-width so it doesn't go too wide on large screens
          position: "relative",
          width: "100%",
          maxWidth: 340,
          margin: "0 auto",
          aspectRatio: "9/16",
          borderRadius: 18,
          overflow: "hidden",
          background: "#000",
          boxShadow: connStatus === "connected"
            ? "0 0 60px hsl(187 100% 52% / 0.3), 0 0 0 2px hsl(187 100% 52% / 0.2)"
            : "0 0 0 1px hsl(222 40% 14%)",
        }
      : {
          position: "relative",
          width: "100%",
          aspectRatio: "16/9",
          borderRadius: 14,
          overflow: "hidden",
          background: "#000",
          boxShadow: connStatus === "connected"
            ? "0 0 40px hsl(187 100% 52% / 0.25), 0 0 0 1px hsl(187 100% 52% / 0.15)"
            : "0 0 0 1px hsl(222 40% 14%)",
        };

    return (
      <div style={panelStyle}>
        {/* AI output video — always clean, no overlay chrome */}
        <video
          ref={el => { remoteVideoRef.current = el; if (el && remoteStreamRef.current && el.srcObject !== remoteStreamRef.current) el.srcObject = remoteStreamRef.current; }}
          onPlaying={markMedia}
          autoPlay playsInline
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", transform: "scaleX(-1)" }} />

        {/* Idle placeholder */}
        {connStatus === "idle" && (
          <div style={{ position: "absolute", inset: 0, zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, background: "radial-gradient(ellipse at center, hsl(222 44% 8%) 0%, hsl(222 47% 4%) 100%)" }}>
            <Zap style={{ width: 32, height: 32, color: C }} />
            <p style={{ fontFamily: "'Orbitron',monospace", fontSize: 14, fontWeight: 700, color: "hsl(190 80% 96%)" }}>AI Video Output</p>
            <p style={{ fontSize: 13, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", textAlign: "center", padding: "0 20px" }}>
              {isPortrait ? "Portrait mode active" : "Enable camera and click Start"}
            </p>
          </div>
        )}

        {/* Transient reconnect indicator — the call is still alive, giving WebRTC a chance to recover */}
        {connStatus === "reconnecting" && (
          <div style={{ position: "absolute", top: 12, left: 12, zIndex: 15, display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderRadius: 999, background: "rgba(0,0,0,0.72)", border: "1px solid rgba(0,210,211,0.5)", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif" }}>
            <Loader2 style={{ width: 14, height: 14, color: C, animation: "spin 1s linear infinite" }} /> Reconnecting…
          </div>
        )}

        {/* OBS / popout / fullscreen overlay — LANDSCAPE ONLY */}
        {!isPortrait && (
          <div style={{ position: "absolute", top: 10, right: 10, zIndex: 20, display: "flex", gap: 6 }}>
            <div style={{ position: "relative" }}>
              <button onClick={isObsModeActive ? closeObs : openObs}
                style={{ display: "flex", alignItems: "center", gap: 5, height: 30, padding: "0 10px", borderRadius: 20, background: isObsModeActive ? "rgba(0,210,211,0.9)" : "rgba(0,0,0,0.6)", color: isObsModeActive ? "hsl(222 47% 4%)" : "#fff", border: isObsModeActive ? "1px solid rgba(0,210,211,0.6)" : "1px solid rgba(255,255,255,0.2)", fontSize: 10, fontWeight: 700, fontFamily: "monospace", letterSpacing: 1, cursor: "pointer" }}>
                <Monitor style={{ width: 11, height: 11 }} /> OBS
              </button>
              {obsInstructions && (
                <div style={{ position: "absolute", top: 36, right: 0, width: 240, background: "hsl(222 44% 7%)", border: "1px solid rgba(0,210,211,0.3)", borderRadius: 12, padding: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.6)", zIndex: 30 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: C, fontFamily: "monospace" }}>● OBS WINDOW OPEN</span>
                    <button onClick={() => setObsInstructions(false)} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", fontSize: 16 }}>×</button>
                  </div>
                  <p style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.5 }}>In OBS → Sources → + → Window Capture → select "Stream Live OBS". For AI audio add Sources → + → Audio Input Capture → "{IS_MAC ? CABLE_NAME : "CABLE Output (VB-Audio Virtual Cable)"}".{IS_MAC ? " Then click Start Virtual Camera in OBS and pick “OBS Virtual Camera” in your call app." : ""}</p>
                </div>
              )}
            </div>
            <button onClick={isPopoutOpen ? closePopout : openPopout} style={{ width: 30, height: 30, borderRadius: "50%", background: isPopoutOpen ? "rgba(0,210,211,0.85)" : "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Monitor style={{ width: 13, height: 13 }} />
            </button>
            <button onClick={() => setIsFullscreen(v => !v)} style={{ width: 30, height: 30, borderRadius: "50%", background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Maximize2 style={{ width: 13, height: 13 }} />
            </button>
          </div>
        )}

        {/* OBS portrait clean-output overlay — PORTRAIT ONLY */}
        {isPortrait && (
          <div style={{ position: "absolute", top: 10, right: 10, zIndex: 20, display: "flex", gap: 6 }}>
            <div style={{ position: "relative" }}>
              <button onClick={isObsPortraitActive ? closeObsPortrait : openObsPortrait}
                style={{ display: "flex", alignItems: "center", gap: 5, height: 30, padding: "0 10px", borderRadius: 20, background: isObsPortraitActive ? "rgba(0,210,211,0.9)" : "rgba(0,0,0,0.6)", color: isObsPortraitActive ? "hsl(222 47% 4%)" : "#fff", border: isObsPortraitActive ? "1px solid rgba(0,210,211,0.6)" : "1px solid rgba(255,255,255,0.2)", fontSize: 10, fontWeight: 700, fontFamily: "monospace", letterSpacing: 1, cursor: "pointer" }}>
                <Monitor style={{ width: 11, height: 11 }} /> OBS 9:16
              </button>
              {obsPortraitInstructions && (
                <div style={{ position: "absolute", top: 36, right: 0, width: 240, background: "hsl(222 44% 7%)", border: "1px solid rgba(0,210,211,0.3)", borderRadius: 12, padding: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.6)", zIndex: 30 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: C, fontFamily: "monospace" }}>● PORTRAIT OBS OPEN</span>
                    <button onClick={() => setObsPortraitInstructions(false)} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", fontSize: 16 }}>×</button>
                  </div>
                  <p style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.5 }}>In OBS → Sources → + → Window Capture → select "Stream Live OBS Portrait" for a clean 9:16 feed.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* PiP local camera — landscape only, hidden in portrait */}
        {!isPortrait && showPiP && (
          <div style={{ position: "absolute", bottom: 10, left: 10, zIndex: 10, width: "22%", aspectRatio: "16/9", borderRadius: 10, overflow: "hidden", border: "1px solid rgba(255,255,255,0.2)", background: "#000" }}>
            <video
              ref={el => { localVideoRef.current = el; if (el && localStreamRef.current && el.srcObject !== localStreamRef.current) el.srcObject = localStreamRef.current; }}
              autoPlay muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
            {cameraReady && (
              <button
                onClick={() => { if (!isStreaming) stopCamera(); }}
                title={isStreaming ? "Stop the stream to turn off the camera" : "Turn off camera"}
                disabled={isStreaming}
                style={{ position: "absolute", top: 4, right: 4, zIndex: 11, width: 22, height: 22, borderRadius: "50%", background: isStreaming ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.65)", border: "1px solid rgba(255,255,255,0.25)", color: isStreaming ? "rgba(255,255,255,0.35)" : "#fff", cursor: isStreaming ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                <CameraOff style={{ width: 12, height: 12 }} />
              </button>
            )}
            {!cameraReady && (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, background: "rgba(0,0,0,0.85)" }}>
                <Camera style={{ width: 18, height: 18, color: "hsl(222 25% 50%)" }} />
                <button onClick={() => startCamera()} style={{ fontSize: 10, color: C, fontWeight: 700, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Enable Camera</button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // ─── Portrait / Landscape toggle button (always outside the video panel) ───
  const OrientationToggle = () => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
      <button
        onClick={togglePortrait}
        title={portraitMode ? "Switch to Landscape (16:9)" : "Switch to Portrait (9:16)"}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 16px", borderRadius: 10, cursor: "pointer",
          background: portraitMode ? "hsl(187 100% 52% / 0.15)" : "hsl(222 40% 8%)",
          border: `1px solid ${portraitMode ? "hsl(187 100% 52% / 0.5)" : "hsl(222 40% 14%)"}`,
          color: portraitMode ? C : "hsl(222 25% 55%)",
          fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 10,
          letterSpacing: "0.06em", textTransform: "uppercase", transition: "all 0.2s",
        }}>
        {portraitMode
          ? <><Smartphone style={{ width: 13, height: 13 }} /> Portrait (9:16)</>
          : <><Monitor style={{ width: 13, height: 13 }} /> Landscape (16:9)</>}
      </button>
      <span style={{ fontSize: 10, color: "hsl(222 25% 40%)", fontFamily: "'Rajdhani',sans-serif" }}>
        {portraitMode ? "Mobile video call mode — clean output" : "Standard widescreen mode"}
      </span>
    </div>
  );

  // These panels are rendered by call ({StreamBtn()}) instead of as JSX elements.
  // Defined inside the render body, each one gets a brand new component identity
  // every render, so React destroys and rebuilds their DOM ~30x/s while streaming
  // (VU + delay + lease updates re-render this page). A button torn down between
  // mousedown and mouseup never fires onClick -- that is why Stop needed several
  // clicks. They hold no hooks, so inlining them is safe and keeps DOM identity.
  // ─── Stream button ─────────────────────────────────────────────────────────
  const canStart = !credsMissing && (needsVideo ? cameraReady : true);
  const StreamBtn = () => (
    <div style={{ position: "fixed", left: `calc(${RAIL_W}px + (100vw - ${RAIL_W}px) / 2)`, transform: "translateX(-50%)", bottom: 18, zIndex: 60, width: `min(440px, calc(100vw - ${RAIL_W}px - 48px))`, filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.55))" }}>
      <MinuteMeter modality={modalityForTab(activeTab)} />
      {isStreaming ? (
        <button onClick={handleStop}
          style={{ width: "100%", height: 54, background: "hsl(0 85% 40% / 0.3)", border: "1px solid hsl(0 85% 55% / 0.5)", borderRadius: 12, cursor: "pointer", color: "hsl(0 85% 75%)", fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.5)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.3)"; }}>
          <Square style={{ width: 18, height: 18 }} /> Stop
        </button>
      ) : (
        <button onClick={credsMissing ? () => setLocation(account.signedIn ? "/minutes" : "/account") : handleStartStream} disabled={isStarting || isClosing || (!credsMissing && !canStart)}
          style={{ width: "100%", height: 54, background: (canStart && !isStarting && !isClosing) ? "linear-gradient(135deg, hsl(187 100% 52%) 0%, hsl(200 100% 45%) 100%)" : "hsl(222 40% 11%)", border: "none", borderRadius: 12, cursor: (canStart && !isStarting && !isClosing) ? "pointer" : "not-allowed", color: (canStart && !isStarting && !isClosing) ? "hsl(222 47% 4%)" : "hsl(222 25% 40%)", fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, boxShadow: (canStart && !isStarting && !isClosing) ? "0 0 28px hsl(187 100% 52% / 0.3)" : "none" }}
          onMouseEnter={e => { if (canStart && !isStarting && !isClosing) (e.currentTarget as HTMLElement).style.filter = "brightness(1.1)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = "none"; }}>
          {isStarting ? <><Loader2 style={{ width: 18, height: 18, animation: "spin 1s linear infinite" }} /> Starting…</>
            : isClosing ? <><Loader2 style={{ width: 18, height: 18, animation: "spin 1s linear infinite" }} /> Ending call…</>
            : credsMissing ? <><Settings style={{ width: 18, height: 18 }} /> Request credits</>
            : !cameraReady && needsVideo ? <><Camera style={{ width: 18, height: 18 }} /> Enable Camera</>
            : <><Play style={{ width: 18, height: 18 }} /> Start</>}
        </button>
      )}
    </div>
  );

  // ─── Voice cloning panel (shared between tabs) ─────────────────────────────
  const VoicePanel = () => (
    <div style={{ background: "hsl(222 44% 6%)", border: `1px solid ${vcEnabled ? "hsl(265 90% 65% / 0.4)" : "hsl(222 40% 11%)"}`, borderRadius: 14, padding: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: VC, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace" }}>Voice Cloning</p>
          {vcActive && <span style={{ fontSize: 8, fontWeight: 700, color: "#fff", background: VC, padding: "2px 6px", borderRadius: 10, fontFamily: "'Orbitron',monospace" }}>LIVE</span>}
        </div>
        {/* Toggle */}
        <button onClick={() => {
          if (!voiceKeySet && !vcEnabled) { toast({ title: "Out of minutes", description: "Ask your administrator to top up this bucket before using voice cloning.", variant: "destructive" }); return; }
          setVcEnabled(v => !v);
        }}
          style={{ width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer", background: vcEnabled ? VC : "hsl(222 40% 14%)", position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
          <span style={{ position: "absolute", top: 3, left: vcEnabled ? 21 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
        </button>
      </div>

      {!voiceKeySet && (
        <div style={{ padding: "8px 12px", borderRadius: 8, background: "hsl(40 100% 52% / 0.08)", border: "1px solid hsl(40 100% 52% / 0.2)", marginBottom: 10 }}>
          <p style={{ fontSize: 11, color: "hsl(40 100% 75%)", fontFamily: "'Rajdhani',sans-serif" }}>
            You have no credit minutes in this bucket. Ask your administrator to top up your account.{" "}
            <button onClick={() => setLocation("/minutes")} style={{ color: "hsl(40 100% 75%)", fontWeight: 700, background: "none", border: "none", cursor: "pointer", textDecoration: "underline", fontFamily: "'Rajdhani',sans-serif", fontSize: 11, padding: 0 }}>Request credits →</button>
          </p>
        </div>
      )}

      {/* Voice selector */}
      <div style={{ marginBottom: 10 }}>
        <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: "hsl(265 70% 60%)", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "'Orbitron',monospace", marginBottom: 6 }}>Clone Voice</label>
        <div style={{ position: "relative" }}>
          <select value={vcVoiceId} onChange={e => setVcVoiceId(e.target.value)} disabled={isStreaming} style={{ ...selectSt, borderColor: vcEnabled ? "hsl(265 90% 65% / 0.4)" : "hsl(222 40% 14%)" }}>
            {savedVoices.length > 0 && (
              <optgroup label="── Your Voices ──">
                {savedVoices.map(v => <option key={v.id} value={v.id}>★ {v.name}</option>)}
              </optgroup>
            )}
            <optgroup label="── Built-in Voices ──">
              {BUILTIN_VOICES.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </optgroup>
          </select>
          <ChevronDown style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "hsl(222 25% 50%)", pointerEvents: "none" }} />
        </div>
      </div>

      {/* Upload your own voice */}
      <div style={{ background: "hsl(222 40% 8%)", borderRadius: 10, padding: 12, marginBottom: 10 }}>
        <p style={{ fontSize: 10, fontWeight: 700, color: "hsl(265 70% 60%)", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "'Orbitron',monospace", marginBottom: 8 }}>Upload Your Voice</p>
        <input
          type="text" placeholder="Voice name (optional)"
          value={uploadVoiceName} onChange={e => setUploadVoiceName(e.target.value)}
          style={{ width: "100%", padding: "7px 10px", borderRadius: 7, background: "hsl(222 47% 4%)", border: "1px solid hsl(222 40% 14%)", color: "hsl(190 80% 96%)", fontSize: 12, fontFamily: "'Rajdhani',sans-serif", outline: "none", marginBottom: 8 }}
          onFocus={e => { e.target.style.borderColor = "hsl(265 90% 65% / 0.5)"; }}
          onBlur={e => { e.target.style.borderColor = "hsl(222 40% 14%)"; }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, cursor: uploadingVoice ? "not-allowed" : "pointer", background: uploadingVoice ? "hsl(222 40% 10%)" : "hsl(265 90% 65% / 0.15)", border: "1px solid hsl(265 90% 65% / 0.35)", color: VC, fontSize: 12, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif" }}>
          {uploadingVoice ? <Loader2 style={{ width: 14, height: 14, animation: "spin 1s linear infinite" }} /> : <Upload style={{ width: 14, height: 14 }} />}
          {uploadingVoice ? "Uploading…" : "Upload Voice Sample (MP3/WAV/M4A)"}
          <input type="file" accept=".mp3,.wav,.m4a,audio/*" onChange={handleVoiceUpload} disabled={uploadingVoice} style={{ display: "none" }} />
        </label>
        <p style={{ fontSize: 10, color: "hsl(222 25% 40%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 6, lineHeight: 1.4 }}>
          Upload 30s–3min of clear speech. Your voice will be cloned and saved for future sessions.
        </p>
      </div>

      {/* Saved voices list */}
      {savedVoices.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: "hsl(265 70% 60%)", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "'Orbitron',monospace", marginBottom: 6 }}>Your Voices</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {savedVoices.map(v => (
              <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 7, background: vcVoiceId === v.id ? "hsl(265 90% 65% / 0.15)" : "hsl(222 40% 8%)", border: `1px solid ${vcVoiceId === v.id ? "hsl(265 90% 65% / 0.4)" : "hsl(222 40% 12%)"}`, cursor: "pointer" }}
                onClick={() => setVcVoiceId(v.id)}>
                <span style={{ fontSize: 11, color: "hsl(190 80% 90%)", fontFamily: "'Rajdhani',sans-serif", flex: 1, fontWeight: vcVoiceId === v.id ? 700 : 400 }}>★ {v.name}</span>
                <button onClick={e => { e.stopPropagation(); handleDeleteVoice(v.id); }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "hsl(0 85% 55%)", padding: 2, display: "flex" }}>
                  <Trash2 style={{ width: 11, height: 11 }} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Waveform — input voice */}
      {vcActive && (
        <div style={{ marginTop: 8 }}>
          <p style={{ fontSize: 9, color: "hsl(222 25% 45%)", fontFamily: "'Orbitron',monospace", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Cloned Voice Output</p>
          <Waveform analyser={vcAnalyser} color={VC} height={60} />
          <div style={{ height: 5, background: "hsl(222 40% 11%)", borderRadius: 3, overflow: "hidden", marginTop: 6 }}>
            <div style={{ height: "100%", borderRadius: 3, transition: "width 0.08s", width: `${vcVu}%`, background: VC }} />
          </div>
          <p style={{ marginTop: 6, fontSize: 10, color: "hsl(265 60% 72%)" }}>
            With cloning on, this cloned voice — not your raw voice — is what the cable sends on “Video + Audio” and “Audio Call”.
          </p>
        </div>
      )}

      {/* Local monitor — only meaningful where cloning actually runs */}
      <div style={{ marginTop: 10, background: "hsl(222 44% 6%)", border: `1px solid ${voiceMonitor ? "hsl(265 90% 65% / 0.35)" : "hsl(222 40% 11%)"}`, borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: voiceMonitor ? "hsl(265 90% 65% / 0.15)" : "hsl(222 40% 10%)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Headphones style={{ width: 15, height: 15, color: voiceMonitor ? VC : "hsl(222 25% 45%)" }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em", marginBottom: 3 }}>Hear my cloned voice</p>
          <p style={{ fontSize: 11, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.4 }}>
            {voiceMonitor
              ? "On — the clone also plays in your own speakers. Wear headphones; loudspeakers let your mic feed it back into the call."
              : "Off — the clone goes to the calling app only. You hear yourself as usual."}
          </p>
        </div>
        <button onClick={toggleVoiceMonitor} aria-pressed={voiceMonitor} title="Toggle local monitor"
          style={{ flexShrink: 0, width: 46, height: 24, borderRadius: 14, border: "none", cursor: "pointer", background: voiceMonitor ? VC : "hsl(222 30% 20%)", position: "relative", transition: "background 0.15s" }}>
          <span style={{ position: "absolute", top: 3, left: voiceMonitor ? 25 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.15s" }} />
        </button>
      </div>
    </div>
  );

  // ─── Device selectors (shared) ─────────────────────────────────────────────
  const DeviceSelectors = ({ showCamera }: { showCamera: boolean }) => (
    <>
      {showCamera && (
        <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "hsl(187 100% 52% / 0.1)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Camera style={{ width: 15, height: 15, color: C }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em" }}>Camera</p>
              <span style={{ fontSize: 10, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif" }}>{cameras.length} found</span>
            </div>
            {cameras.length === 0 ? <p style={{ fontSize: 12, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif" }}>No cameras found.</p> : (
              <div style={{ position: "relative" }}>
                <select value={selectedCamId} onChange={e => handleCameraSwitch(e.target.value)} disabled={isStreaming} style={selectSt}>
                  {cameras.map((c, i) => <option key={c.deviceId} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
                </select>
                <ChevronDown style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "hsl(222 25% 50%)", pointerEvents: "none" }} />
              </div>
            )}
          </div>
          <button onClick={enumerateDevices} style={{ background: "none", border: "none", cursor: "pointer", color: "hsl(222 25% 50%)", padding: 4 }}><RefreshCw style={{ width: 13, height: 13 }} /></button>
        </div>
      )}

      <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: "hsl(187 100% 52% / 0.1)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Mic style={{ width: 15, height: 15, color: C }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em" }}>Microphone</p>
            <span style={{ fontSize: 10, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif" }}>{mics.length} found</span>
          </div>
          {mics.length === 0 ? <p style={{ fontSize: 12, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif" }}>No microphones found.</p> : (
            <div style={{ position: "relative" }}>
              <select value={selectedMicId} onChange={e => setSelectedMicId(e.target.value)} disabled={isStreaming} style={selectSt}>
                {mics.map((m, i) => <option key={m.deviceId} value={m.deviceId}>{m.label || `Microphone ${i + 1}`}</option>)}
              </select>
              <ChevronDown style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "hsl(222 25% 50%)", pointerEvents: "none" }} />
            </div>
          )}
        </div>
        <button onClick={enumerateDevices} style={{ background: "none", border: "none", cursor: "pointer", color: "hsl(222 25% 50%)", padding: 4 }}><RefreshCw style={{ width: 13, height: 13 }} /></button>
      </div>

      {/* Noise cancellation */}
      <div style={{ background: "hsl(222 44% 6%)", border: `1px solid ${noiseCancel ? "hsl(187 100% 52% / 0.35)" : "hsl(222 40% 11%)"}`, borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: noiseCancel ? "hsl(187 100% 52% / 0.15)" : "hsl(222 40% 10%)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Mic style={{ width: 15, height: 15, color: noiseCancel ? C : "hsl(222 25% 45%)" }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em", marginBottom: 3 }}>Noise Cancellation</p>
          <p style={{ fontSize: 11, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.4 }}>
            {noiseCancel ? "Filtering background & external noise from your mic." : "Off — raw microphone audio. Applies when you next start."}
          </p>
        </div>
        <button onClick={toggleNoiseCancel} aria-pressed={noiseCancel} title="Toggle noise cancellation"
          style={{ flexShrink: 0, width: 46, height: 24, borderRadius: 14, border: "none", cursor: "pointer", background: noiseCancel ? C : "hsl(222 30% 20%)", position: "relative", transition: "background 0.15s" }}>
          <span style={{ position: "absolute", top: 3, left: noiseCancel ? 25 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.15s" }} />
        </button>
      </div>
    </>
  );

  // ─── Virtual device broadcast panel (Stream Live Camera / Microphone) ─────
  // Plain render function (not a nested component) so it reconciles in place and
  // never remounts the video subtree.
  const renderVirtualDevices = (showCamera: boolean) => {
    const rowSt: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, background: "hsl(222 40% 8%)", border: "1px solid hsl(222 40% 12%)" };
    const toggleBtn = (on: boolean, onClick: () => void, disabled: boolean, label: string) => (
      <button onClick={onClick} disabled={disabled}
        style={{ flexShrink: 0, width: 46, height: 24, borderRadius: 14, border: "none", cursor: disabled ? "not-allowed" : "pointer", background: on ? C : "hsl(222 30% 20%)", position: "relative", opacity: disabled ? 0.5 : 1, transition: "background 0.15s" }}>
        <span style={{ position: "absolute", top: 3, left: on ? 25 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.15s" }} />
        <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{label}</span>
      </button>
    );
    return (
      <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace" }}>Broadcast to Calls</p>
          <span style={{ fontSize: 9, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif" }}>Zoom · Teams · Chrome · WhatsApp</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {showCamera && (IS_MAC ? (
            <div style={rowSt}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: "hsl(222 40% 10%)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Camera style={{ width: 14, height: 14, color: "hsl(222 25% 45%)" }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 12, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif" }}>Stream Live Camera</p>
                <p style={{ fontSize: 10, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.45 }}>
                  On a Mac, AI video leaves through OBS Virtual Camera.
                </p>
              </div>
              <button onClick={() => setLocation("/settings")}
                style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 8, background: "hsl(187 100% 52% / 0.12)", border: "1px solid hsl(187 100% 52% / 0.35)", color: C, fontWeight: 700, fontSize: 10, fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em", cursor: "pointer" }}>
                MAC SETUP
              </button>
            </div>
          ) : (
            <div style={rowSt}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: vcamEnabled ? "hsl(187 100% 52% / 0.15)" : "hsl(222 40% 10%)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Camera style={{ width: 14, height: 14, color: vcamEnabled ? C : "hsl(222 25% 45%)" }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 12, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif" }}>Stream Live Camera</p>
                <p style={{ fontSize: 10, color: vcamReady ? C : "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif" }}>
                  {!vcamSupported ? "Driver layer unavailable" : vcamReady ? "Live — a call app is receiving video" : vcamEnabled ? "Waiting for a call app to open it…" : "Off"}
                </p>
              </div>
              {toggleBtn(vcamEnabled, toggleVCam, false, "Toggle Stream Live Camera")}
            </div>
          ))}

          <div style={rowSt}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: audioRouteOn ? "hsl(265 90% 65% / 0.15)" : "hsl(222 40% 10%)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Mic style={{ width: 14, height: 14, color: audioRouteOn ? VC : "hsl(222 25% 45%)" }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif" }}>Stream Live Microphone</p>
              <p style={{ fontSize: 10, color: audioRouteOn ? VC : "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {audioRouteOn ? (cableSinkLabel ? `Routing → ${cableSinkLabel}` : "Routing AI audio to cable") : "Off — AI audio plays to speakers"}
              </p>
            </div>
            {toggleBtn(audioRouteOn, toggleAudioRoute, false, "Toggle Stream Live Microphone")}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", flexShrink: 0 }}>Audio out:</span>
            <select
              value={manualSinkId}
              onChange={e => chooseManualSink(e.target.value)}
              title={`Which output the AI audio is sent to. Pick the ${CABLE_NAME} entry if auto-detect fails.`}
              style={{ flex: 1, minWidth: 0, background: "hsl(222 40% 8%)", color: "hsl(190 80% 90%)", border: "1px solid hsl(222 40% 16%)", borderRadius: 8, padding: "6px 8px", fontSize: 11, fontFamily: "'Rajdhani',sans-serif" }}>
              <option value="">Auto-detect ({IS_MAC ? "BlackHole" : "VB-Cable"})</option>
              {audioOutputs.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Output ${i + 1} (unlabeled — likely ${IS_MAC ? "BlackHole" : "VB-Cable"})`}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 10, background: "hsl(222 40% 8%)", border: "1px solid hsl(222 40% 12%)", fontSize: 10, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.55 }}>
          <p style={{ fontWeight: 700, color: "hsl(190 80% 90%)", marginBottom: 4 }}>What to pick inside OBS / Zoom / Teams</p>
          {IS_MAC ? (
            <>
              <p>• VIDEO → <span style={{ color: C }}>OBS Virtual Camera</span>, once OBS is capturing the “Stream Live OBS” window and Start Virtual Camera is on.</p>
              <p>• AUDIO (AI voice) → <span style={{ color: VC }}>{CABLE_NAME}</span> as the microphone. Your real mic is a separate entry — pick it only if you want yourself heard too.</p>
              <p>• A Mac cannot host a system webcam without an Apple-approved extension, so video always goes through OBS here. Turn on “Stream Live Microphone” above and BlackHole carries the <span style={{ color: VC }}>cloned voice</span>.</p>
              <p style={{ marginTop: 4 }}>OBS recipe: Sources → + → Window Capture → “Stream Live OBS”; then Sources → + → Audio Input Capture → “{CABLE_NAME}”. If you hear echo, mute OBS “Desktop Audio”. Full steps: Settings → Mac Setup.</p>
            </>
          ) : (
            <>
              <p>• VIDEO → <span style={{ color: C }}>Stream Live Camera</span> = the AI video. Your physical webcam is listed next to it — don't pick that one for AI.</p>
              <p>• AUDIO (AI voice) → <span style={{ color: VC }}>CABLE Output (VB-Audio Virtual Cable)</span>. On fresh installs it is named <span style={{ color: VC }}>Stream Live Microphone</span> — same device, two possible names.</p>
              <p>• AUDIO (your own voice) → your Realtek / USB mic. Add it only if you want yourself heard as well.</p>
              <p>• On “Video + Audio” and “Audio Call”, with voice cloning on the cable carries the <span style={{ color: VC }}>cloned voice</span>; your raw voice is muted on the outgoing side. “Video Call” always sends your real voice.</p>
              <p style={{ marginTop: 4 }}>OBS recipe: Sources → + → Video Capture Device → “Stream Live Camera”; then Sources → + → Audio Input Capture → “CABLE Output (VB-Audio Virtual Cable)”. If you hear echo, mute OBS “Desktop Audio”.</p>
            </>
          )}
        </div>
      </div>
    );
  };

  // ─── Audio sync status panel ───────────────────────────────────────────────
  const AudioSyncPanel = () => (
    <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace" }}>Audio Sync</p>
        <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 20, background: audioActive ? "hsl(187 100% 52% / 0.12)" : "hsl(222 40% 9%)", border: `1px solid ${audioActive ? "hsl(187 100% 52% / 0.35)" : "hsl(222 40% 14%)"}` }}>
          {audioActive ? <Wifi style={{ width: 10, height: 10, color: C }} /> : <WifiOff style={{ width: 10, height: 10, color: "hsl(222 25% 40%)" }} />}
          <span style={{ fontSize: 9, fontWeight: 700, fontFamily: "'Orbitron',monospace", color: audioActive ? C : "hsl(222 25% 40%)" }}>{audioActive ? "SYNCED" : "IDLE"}</span>
        </div>
      </div>
      {audioActive ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <Mic style={{ width: 11, height: 11, color: C }} />
              <span style={{ fontSize: 11, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif" }}>{mics.find(m => m.deviceId === selectedMicId)?.label || "Microphone"}</span>
            </div>
            <div style={{ height: 6, background: "hsl(222 40% 11%)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", borderRadius: 3, transition: "width 0.05s", width: `${vuLevel}%`, background: vuLevel > 80 ? "hsl(0 85% 55%)" : vuLevel > 50 ? "hsl(40 100% 55%)" : C }} />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", borderRadius: 8, background: "hsl(222 40% 8%)", border: "1px solid hsl(222 40% 12%)" }}>
            <span style={{ fontSize: 12, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif" }}>Auto-sync delay</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: C, fontFamily: "'Orbitron',monospace" }}>{syncDelay.toFixed(2)}s</span>
          </div>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5 }}>
          Mic audio is auto-delayed to match AI video lip movements when streaming starts.
        </p>
      )}
    </div>
  );

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <AppLayout>
      {/* Cloned voice playback — routed to the virtual microphone so calling
          apps and OBS hear the persona voice instead of the raw mic. */}
      <audio ref={cloneAudioRef} autoPlay style={{ display: "none" }} />

      {/* Out-of-minutes banner */}
      {credsMissing && (
        <div style={{ margin: "16px 32px 0", padding: "12px 18px", borderRadius: 10, background: "hsl(40 100% 52% / 0.1)", border: "1px solid hsl(40 100% 52% / 0.35)", display: "flex", alignItems: "center", gap: 12 }}>
          <Settings style={{ width: 16, height: 16, color: "hsl(40 100% 62%)", flexShrink: 0 }} />
          <p style={{ fontSize: 13, color: "hsl(40 100% 75%)", fontFamily: "'Rajdhani',sans-serif", flex: 1 }}>
            You have no credit minutes in this bucket. Ask your administrator to top up your account.
          </p>
          <button onClick={() => setLocation("/minutes")} style={{ padding: "6px 14px", borderRadius: 8, background: "hsl(40 100% 52% / 0.25)", border: "1px solid hsl(40 100% 52% / 0.5)", color: "hsl(40 100% 80%)", fontWeight: 700, fontSize: 12, fontFamily: "'Orbitron',monospace", cursor: "pointer" }}>
            Request credits
          </button>
        </div>
      )}

      {/* Starting overlay */}
      {isStarting && (
        <div style={{ position: "fixed", inset: 0, zIndex: 55, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "absolute", inset: 0, backdropFilter: "blur(8px)", background: "hsl(222 47% 4% / 0.88)" }} />
          <div style={{ position: "relative", zIndex: 10, display: "flex", flexDirection: "column", alignItems: "center", gap: 20, maxWidth: 360, width: "100%", margin: "0 16px", textAlign: "center", padding: 36, borderRadius: 20, background: "hsl(222 44% 6%)", border: "1px solid hsl(187 100% 52% / 0.22)" }}>
            <Loader2 style={{ width: 40, height: 40, color: C, animation: "spin 1s linear infinite" }} />
            <div>
              <h3 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 16, color: "hsl(190 80% 96%)", marginBottom: 8 }}>Starting…</h3>
              <p style={{ fontSize: 13, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif" }}>
                {connStep === "engine" ? "2/2 · Connecting to AI engine…" : "1/2 · Authorizing your account…"}
              </p>
            </div>
            <button onClick={() => teardownStream()} style={{ padding: "10px 20px", borderRadius: 8, width: "100%", background: "transparent", border: "1px solid hsl(187 100% 52% / 0.25)", color: "hsl(187 100% 52% / 0.8)", fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani',sans-serif", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <X style={{ width: 14, height: 14 }} /> Cancel
            </button>
          </div>
        </div>
      )}

      {/* Fullscreen overlay */}
      {isFullscreen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9000, background: "#000" }}>
          <video autoPlay playsInline ref={el => { if (el && remoteStreamRef.current) el.srcObject = remoteStreamRef.current; }}
            style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
          <button onClick={() => { teardownStream(); setIsFullscreen(false); }}
            style={{ position: "absolute", top: 16, left: 16, width: 36, height: 36, borderRadius: "50%", background: "rgba(220,38,38,0.85)", border: "none", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <X style={{ width: 16, height: 16 }} />
          </button>
          {isStreaming && <div style={{ position: "absolute", top: 16, right: 16, padding: "4px 12px", borderRadius: 20, background: "rgba(0,0,0,0.6)", color: C, fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 13 }}>{formatTime(elapsed)}</div>}
        </div>
      )}

      <div style={{ padding: "24px 32px", maxWidth: 1400, margin: "0 auto" }}>

        {/* Page header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 20, color: "hsl(190 80% 96%)", marginBottom: 2 }}>{APP}</h1>
            <p style={{ fontSize: 13, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif" }}>Real-time AI video &amp; voice transformation</p>
          </div>
          {isStreaming && connStatus === "connected" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderRadius: 10, background: "hsl(0 85% 55% / 0.1)", border: "1px solid hsl(0 85% 55% / 0.2)" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "hsl(0 85% 65%)", animation: "pulse 2s ease-in-out infinite" }} />
              <span style={{ fontSize: 11, color: "hsl(0 85% 70%)", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700 }}>LIVE · {formatTime(elapsed)}</span>
            </div>
          )}
        </div>

        {/* ── 3 TABS ─────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 6, marginBottom: 24, background: "hsl(222 44% 5%)", padding: 5, borderRadius: 16, border: "1px solid hsl(222 40% 10%)" }}>
          {TABS.map(tab => {
            const active = activeTab === tab.id;
            return (
              <button key={tab.id} onClick={() => switchTab(tab.id)}
                style={{
                  flex: 1, padding: "12px 8px", borderRadius: 12, cursor: "pointer", border: "none",
                  transition: "all 0.25s",
                  background: active
                    ? `linear-gradient(135deg, ${tab.color}28, ${tab.color}10)`
                    : "transparent",
                  boxShadow: active
                    ? `inset 0 0 0 1.5px ${tab.color}80, 0 0 20px ${tab.glow}`
                    : "none",
                }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  {/* Icon with coloured bg circle when active */}
                  <div style={{
                    width: 36, height: 36, borderRadius: "50%",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: active ? `${tab.color}22` : "transparent",
                    border: active ? `1px solid ${tab.color}55` : "1px solid transparent",
                    transition: "all 0.25s",
                  }}>
                    <tab.Icon style={{ width: 18, height: 18, color: active ? tab.color : "hsl(222 25% 45%)" }} />
                  </div>
                  {/* Label */}
                  <span style={{
                    fontSize: 11, fontWeight: 800, fontFamily: "'Orbitron',monospace",
                    letterSpacing: "0.05em", textTransform: "uppercase",
                    color: active ? tab.color : "hsl(222 25% 50%)",
                    transition: "color 0.2s",
                  }}>
                    {tab.label}
                  </span>
                  {/* Sub-label */}
                  <span style={{
                    fontSize: 9, fontFamily: "'Rajdhani',sans-serif",
                    color: active ? `${tab.color}CC` : "hsl(222 25% 35%)",
                    transition: "color 0.2s",
                    letterSpacing: "0.02em",
                  }}>
                    {tab.sub}
                  </span>
                  {/* Active indicator dot */}
                  {active && (
                    <div style={{
                      width: 5, height: 5, borderRadius: "50%",
                      background: tab.color,
                      boxShadow: `0 0 6px ${tab.color}`,
                    }} />
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* ══════════════════════════════════════════════════════════════════ */}
        {/* TAB 1: Video + Audio                                              */}
        {/* ══════════════════════════════════════════════════════════════════ */}
        {activeTab === "video-audio" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 316px", gap: 20 }}>
            {/* Left */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* AI Output video — portrait or landscape */}
              {renderVideoOutput(true)}
              {/* Orientation toggle — always outside the video, always clean */}
              {OrientationToggle()}
              <DeviceSelectors showCamera={true} />
              {renderVirtualDevices(true)}
            </div>
            {/* Right sidebar */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Style presets */}
              <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 16 }}>
                <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", marginBottom: 12 }}>AI Style</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                  {STYLES.map(s => (
                    <button key={s.id} onClick={() => handleStyleSelect(s.id)}
                      style={{ padding: "7px 4px", borderRadius: 8, cursor: "pointer", background: selectedStyle === s.id ? `${s.color}22` : "hsl(222 40% 8%)", border: `1px solid ${selectedStyle === s.id ? s.color + "66" : "hsl(222 40% 12%)"}`, color: selectedStyle === s.id ? s.color : "hsl(222 25% 55%)", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", fontFamily: "'Orbitron',monospace", boxShadow: selectedStyle === s.id ? `0 0 12px ${s.color}33` : "none" }}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              {/* Custom prompt */}
              <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 16 }}>
                <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", marginBottom: 8 }}>Custom Prompt</p>
                <textarea value={customPrompt} onChange={e => handleCustomPromptChange(e.target.value)} placeholder={curStyle.prompt} rows={3}
                  style={{ width: "100%", padding: 10, borderRadius: 8, resize: "vertical", background: "hsl(222 47% 4%)", border: "1px solid hsl(222 40% 14%)", color: "hsl(190 80% 96%)", fontSize: 12, fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5, outline: "none" }}
                  onFocus={e => { e.target.style.borderColor = "hsl(187 100% 52% / 0.5)"; }}
                  onBlur={e => { e.target.style.borderColor = "hsl(222 40% 14%)"; }} />
                {customPrompt && <button onClick={() => handleCustomPromptChange("")} style={{ marginTop: 6, fontSize: 11, color: "hsl(222 25% 50%)", background: "none", border: "none", cursor: "pointer", fontFamily: "'Rajdhani',sans-serif" }}>↺ Reset</button>}
              </div>
              {AudioSyncPanel()}
              {VoicePanel()}
              {/* Reference image */}
              <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 16 }}>
                <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", marginBottom: 10 }}>Reference Image</p>
                {refImagePreview ? (
                  <div style={{ position: "relative" }}>
                    <img src={refImagePreview} alt="Ref" style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", borderRadius: 8, border: "1px solid hsl(187 100% 52% / 0.3)" }} />
                    <button onClick={() => { setRefImagePreview(null); setRefImageB64(null); }} style={{ position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: "50%", background: "rgba(220,38,38,0.8)", border: "none", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <X style={{ width: 10, height: 10 }} />
                    </button>
                  </div>
                ) : (
                  <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "18px 12px", borderRadius: 10, cursor: "pointer", background: "hsl(222 40% 8%)", border: "1px dashed hsl(222 40% 16%)" }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "hsl(187 100% 52% / 0.4)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "hsl(222 40% 16%)"; }}>
                    <Image style={{ width: 22, height: 22, color: "hsl(222 25% 40%)" }} />
                    <p style={{ fontSize: 12, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", textAlign: "center" }}>Upload face reference to guide the AI</p>
                    <input type="file" accept="image/*" onChange={handleRefImage} style={{ display: "none" }} />
                  </label>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════ */}
        {/* TAB 2: Audio Call Only                                            */}
        {/* ══════════════════════════════════════════════════════════════════ */}
        {activeTab === "audio-only" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 316px", gap: 20 }}>
            {/* Left */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Waveform display */}
              <div style={{ borderRadius: 14, overflow: "hidden", background: "hsl(222 44% 5%)", border: `1px solid ${connStatus === "connected" ? "hsl(265 90% 65% / 0.4)" : "hsl(222 40% 14%)"}`, padding: 24, boxShadow: connStatus === "connected" ? "0 0 40px hsl(265 90% 65% / 0.15)" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 10, background: "hsl(265 90% 65% / 0.15)", border: "1px solid hsl(265 90% 65% / 0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Headphones style={{ width: 20, height: 20, color: VC }} />
                    </div>
                    <div>
                      <p style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 13, color: "hsl(190 80% 96%)" }}>Audio Call</p>
                      <p style={{ fontSize: 11, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif" }}>Voice cloning active</p>
                    </div>
                  </div>
                  {connStatus === "connected" && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", borderRadius: 20, background: "hsl(265 90% 65% / 0.15)", border: "1px solid hsl(265 90% 65% / 0.4)" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: VC, animation: "pulse 2s ease-in-out infinite" }} />
                      <span style={{ fontSize: 10, color: VC, fontFamily: "'Orbitron',monospace", fontWeight: 700 }}>LIVE</span>
                    </div>
                  )}
                </div>

                {/* Input waveform */}
                <div style={{ marginBottom: 12 }}>
                  <p style={{ fontSize: 9, color: "hsl(222 25% 40%)", fontFamily: "'Orbitron',monospace", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Your Voice (Input)</p>
                  <Waveform analyser={micAnalyser} color={C} height={72} />
                </div>

                {/* Output waveform */}
                <div>
                  <p style={{ fontSize: 9, color: "hsl(265 70% 60%)", fontFamily: "'Orbitron',monospace", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Cloned Voice (Output)</p>
                  <Waveform analyser={vcAnalyser} color={VC} height={72} />
                </div>

                {/* Volume bar */}
                {vcActive && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ height: 6, background: "hsl(222 40% 11%)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", borderRadius: 3, transition: "width 0.08s", width: `${vcVu}%`, background: `linear-gradient(90deg, ${VC}, hsl(200 80% 65%))` }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                      <span style={{ fontSize: 9, color: "hsl(222 25% 40%)", fontFamily: "'Rajdhani',sans-serif" }}>Output level</span>
                      <Volume2 style={{ width: 11, height: 11, color: VC }} />
                    </div>
                  </div>
                )}
              </div>

              <DeviceSelectors showCamera={false} />
              {renderVirtualDevices(false)}
            </div>
            {/* Right */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {VoicePanel()}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════ */}
        {/* TAB 3: Video Call Only                                            */}
        {/* ══════════════════════════════════════════════════════════════════ */}
        {activeTab === "video-only" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 316px", gap: 20 }}>
            {/* Left */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {renderVideoOutput(true)}
              {OrientationToggle()}
              <DeviceSelectors showCamera={true} />
              {renderVirtualDevices(true)}
            </div>
            {/* Right */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 16 }}>
                <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", marginBottom: 12 }}>AI Style</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                  {STYLES.map(s => (
                    <button key={s.id} onClick={() => handleStyleSelect(s.id)}
                      style={{ padding: "7px 4px", borderRadius: 8, cursor: "pointer", background: selectedStyle === s.id ? `${s.color}22` : "hsl(222 40% 8%)", border: `1px solid ${selectedStyle === s.id ? s.color + "66" : "hsl(222 40% 12%)"}`, color: selectedStyle === s.id ? s.color : "hsl(222 25% 55%)", fontSize: 9, fontWeight: 700, fontFamily: "'Orbitron',monospace", boxShadow: selectedStyle === s.id ? `0 0 12px ${s.color}33` : "none" }}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 16 }}>
                <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", marginBottom: 8 }}>Custom Prompt</p>
                <textarea value={customPrompt} onChange={e => handleCustomPromptChange(e.target.value)} placeholder={curStyle.prompt} rows={3}
                  style={{ width: "100%", padding: 10, borderRadius: 8, resize: "vertical", background: "hsl(222 47% 4%)", border: "1px solid hsl(222 40% 14%)", color: "hsl(190 80% 96%)", fontSize: 12, fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5, outline: "none" }}
                  onFocus={e => { e.target.style.borderColor = "hsl(187 100% 52% / 0.5)"; }}
                  onBlur={e => { e.target.style.borderColor = "hsl(222 40% 14%)"; }} />
              </div>
              {AudioSyncPanel()}
              <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 16 }}>
                <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", marginBottom: 10 }}>Reference Image</p>
                {refImagePreview ? (
                  <div style={{ position: "relative" }}>
                    <img src={refImagePreview} alt="Ref" style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", borderRadius: 8, border: "1px solid hsl(187 100% 52% / 0.3)" }} />
                    <button onClick={() => { setRefImagePreview(null); setRefImageB64(null); }} style={{ position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: "50%", background: "rgba(220,38,38,0.8)", border: "none", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <X style={{ width: 10, height: 10 }} />
                    </button>
                  </div>
                ) : (
                  <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "18px 12px", borderRadius: 10, cursor: "pointer", background: "hsl(222 40% 8%)", border: "1px dashed hsl(222 40% 16%)" }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "hsl(187 100% 52% / 0.4)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "hsl(222 40% 16%)"; }}>
                    <Image style={{ width: 22, height: 22, color: "hsl(222 25% 40%)" }} />
                    <p style={{ fontSize: 12, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", textAlign: "center" }}>Upload face reference</p>
                    <input type="file" accept="image/*" onChange={handleRefImage} style={{ display: "none" }} />
                  </label>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Always-visible Start/Stop action bar (fixed, shown on every tab) */}
      {StreamBtn()}

      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}`}</style>
    </AppLayout>
  );
}
