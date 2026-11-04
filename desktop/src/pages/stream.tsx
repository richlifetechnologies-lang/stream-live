import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { AppLayout, RAIL_W } from "../components/layout";
import { WatermarkOffer } from "../components/watermark-offer";
import { useToast } from "../hooks/use-toast";
import {
  getSavedVoices, addSavedVoice, removeSavedVoice, type SavedVoice,
} from "../lib/credentials";
import { gateway, deviceId, useAccount, useAdminContact, bucketFor, hasMinutes, cloneOpen, voiceCloneOpen, modalityForTab, refreshBalances, beginLease, updateLease, endLease, markMedia, reportCallFailure, reportCallEnd, noteClockSkew } from "../lib/gateway";
import { stopDeadlineAt } from "../lib/minutes";
import { MinuteMeter } from "../components/meter";
import { Stage, PageHead, Pill, PillRow } from "../components/d2";
import { LanguageMenu } from "../components/lang-menu";
import { CABLE_ANY_RE, CABLE_NAME, CABLE_OUTPUT_RE, IS_MAC } from "../lib/platform";
import { GatewayError, type TabName } from "@stream-live/client";
import { endReasonMessage, toUserMessage } from "../lib/end-reason";
import { BLIND_RETRY_HOLD_MS, PICTURE_GIVE_UP_MS, START_TRIES, classifyStartFailure, preflightFailure, startFailureMessage, startRetryWaitMs, startTriesFor, type StartFailure } from "../lib/start-retry";
import { CLOCK_NOTICE_MS, alignClock, clockSkewMs, describeClockSkew } from "../lib/clock-sync";
import { noPictureCause, noPictureDetail, type NoPictureEvidence } from "../lib/no-picture-cause";
import { drawOutputFrame } from "../lib/vcam-frame";
import { VoiceGate, voiceBandLevel, gateState, type GateState } from "../lib/voicegate";
import { FALLBACK_HOLD, LipSyncEstimator, MAX_HOLD, type SyncReason } from "../lib/lipsync";
import { FRAME_W, FRAME_H, AVATAR_BAND, bandMotion } from "../lib/face-motion";
import {
  Zap, Square, Play, Camera, Monitor, Maximize2, RefreshCw,
  ChevronDown, Image, Loader2, X, Settings, Mic, Wifi, WifiOff,
  Volume2, Upload, Trash2, Video, Headphones, VideoIcon, Smartphone, CameraOff, Sparkles, Lock, Clock,
} from "lucide-react";
import { GuidedTour, onTourRequested, tourSeen, tourStops } from "../components/guided-tour";
import { encode, decode } from "@msgpack/msgpack";
import { t } from "../lib/i18n";

// ─── Branding ─────────────────────────────────────────────────────────────────
const APP = "Stream Live";

// ─── Tab definitions ──────────────────────────────────────────────────────────
// Three tabs, three kinds of call, one pool of minutes behind all three. Each tab holds exactly
// one Start press, so nothing on a tab can contradict the tab: the picture-and-voice call and the
// voice-alone call used to share one screen and one switch, and the switch only ever governed one
// of the two presses.
type TabId = "video-audio" | "video-only" | "audio-only";
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
    id: "video-only",
    label: "Video Call",
    sub: "AI video, natural voice",
    Icon: Video,
    color: "hsl(35 100% 55%)",        // amber/orange
    glow:  "hsl(35 100% 55% / 0.25)",
  },
  {
    id: "audio-only",
    label: "Voice Clone Only",
    sub: "Cloned voice, no picture",
    Icon: Headphones,
    color: "hsl(265 90% 65%)",        // the cloning violet the panel already wears
    glow:  "hsl(265 90% 65% / 0.25)",
  },
];

// ─── Which tab the page opens on ───────────────────────────────────────────────
// A tab the customer chose himself is remembered on this machine and opened next time.
// Until he chooses, the natural-voice tab is the opening tab: the two cloning tabs are shut to an
// account the seller has not opened them for, and one pool of minutes means a balance can no
// longer tell the tabs apart, so the money cannot be the clue any more.
const TAB_STORAGE = "ss_open_tab";
// The trial card is said once per machine, not once per call: a customer who has read that his
// free minutes put a mark on the picture does not need it again, and a popup that returns every
// call is the kind he learns to press without reading.
const TRIAL_CARD_SEEN = "ss_trial_card_seen";
function savedTab(): TabId | null {
  try {
    const v = localStorage.getItem(TAB_STORAGE);
    return v === "video-audio" || v === "video-only" || v === "audio-only" ? v : null;
  } catch { return null; }
}

/** Remember a tab he chose himself. A shut door is never remembered: keeping a cloning tab for an
 *  account that cannot use it would open the app on it every time this machine starts. */
function rememberTabPick(tab: TabId, mayUse: boolean) {
  if (tab !== "video-only" && !mayUse) return;
  try { localStorage.setItem(TAB_STORAGE, tab); } catch { /* remembering is a convenience */ }
}

// ─── Per-tab isolated state ────────────────────────────────────────────────────
// Each tab is an independent workspace: its own selected camera & mic, style, prompt, reference
// image and chosen voice. This hook stores a separate value per TabId but exposes the SAME
// [value, setValue] shape as useState, so call sites are unchanged and switching
// tabs never leaks one tab's inputs/uploads into another.
const TAB_IDS: TabId[] = ["video-audio", "video-only", "audio-only"];
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
// Captures the selected mic and splits it in two: the AI is fed your voice the
// instant you make it, and the copy that goes to the virtual microphone is held
// back until the avatar's lips have actually moved. Those are different amounts on
// purpose. One shared delay could never line the two up, because the picture lags
// the sound by however long the engine takes to render - delaying both by the same
// number shifts the whole call later and leaves the gap exactly as wide as it was.
// How long that hold is stays the app's own measurement, and the rules for making
// it live in the lip-sync module so they can be replayed offline.

const WINDOW_MS  = 60;
// How fast the gate fades rather than snaps. A hard switch on and off at the sample rate
// clicks on every word, and a click inside a call is a complaint.
const GATE_RAMP  = 0.015;
// How fast the hold slides to a new figure. Snapping it skips or replays exactly the difference in
// seconds of his speech, so a mid-call change would cost everyone on the call a word.
const HOLD_RAMP  = 0.05;
const MIC_CHECK_SECONDS = 8;   // long enough to learn a room, short enough to hand the mic back

// How long the cable will wait for the cloned voice before putting his natural microphone
// back on it. Long enough that an ordinary pause in the conversation never flips it - the
// clone owns the cable while it is answering - and short enough that a customer is never
// left hearing nothing for the rest of a call.
const CLONE_ALIVE_SECONDS = 20;

// What the card says, in the customer's own terms. No threshold figures and no device names: he
// needs to know whether the app is hearing him, and whether it is holding the room back.
// What the timing card says, in the state it is actually in. The badge and the sentence are the same
// four cases: a figure it found, a picture that keeps up, a picture missing or frozen, and a call it is
// still watching. Nothing here stops a call or asks anyone to do anything before they dial.
type SyncState = SyncReason | "live";
const SYNC_BADGE: Record<SyncState, string> = {
  measured:  "SYNCED",
  live:      "IN STEP",
  picture:   "NO PICTURE",
  movement:  "STILL PICTURE",
  waiting:   "MEASURING",
};
const SYNC_WORDS: Record<SyncState, string> = {
  measured:  "Your voice is held back by that much, so callers hear each word at the moment the avatar's mouth makes it. Once it has found this, it keeps it for the rest of the call.",
  live:      "Your picture keeps up with your voice, so nothing is held back.",
  picture:   "There is no avatar picture to hear your voice in yet. Nothing is held back until there is, and the voice stays level with the picture.",
  movement:  "The avatar picture is not moving at all, so there is nothing to line your voice up against. Nothing is held back, and the voice stays level with the picture.",
  waiting:   "Listening for your voice in the avatar's mouth. It needs about twenty seconds of talking before it holds your voice back, and until then the voice stays level with the picture.",
};

const MIC_CARD_WORDS: Record<GateState, string> = {
  silent:   "Not listening yet — check your microphone is allowed",
  learning: "Learning how your room sounds — speak normally",
  open:     "Open — that is your voice",
  quiet:    "Held closed — this is your room, not your voice",
};

// ─── Microphone capture constraints ──────────────────────────────────────────
// Browser-native noise cancellation: suppresses background/external noise,
// removes echo and normalises level. Always requested, with no switch - every
// customer would have had to understand it before turning it on, and most never do.
// What it used to be switched off for is now done by the gate, which is automatic.
function micAudioConstraints(deviceId: string | undefined, sampleRate?: number): MediaTrackConstraints {
  const c: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (sampleRate) c.sampleRate = sampleRate;
  if (deviceId) c.deviceId = { exact: deviceId };
  return c;
}

// The avatar's picture is sampled through ../lib/face-motion, which is also what the offline checks
// replay, so the figures the timing runs on are the ones that were proved rather than ones the page
// invented. What is held back on the cable is measured after the hold, on its own bar: the bar on
// screen has to be the bar OBS gets, or it tells the customer a lie about his own call.
// What the AI's ears are turned down to while the app is convinced it is not his voice. Half, and
// never zero: this leg has to stay open, because a detector that decides wrongly about a quiet
// person or a loud one-off sound would otherwise silence the avatar completely - the one failure no
// customer can be talked around, and the reason this leg has never carried the gate itself.
const ENGINE_DUCK = 0.5;

class AudioSyncPipeline {
  private audioCtx:   AudioContext | null = null;
  private analyser:   AnalyserNode  = null!;
  private cableAnalyser: AnalyserNode | null = null;
  private gateNode:   GainNode      | null = null;
  private engineNode: GainNode      | null = null;
  private delayNode:  DelayNode     | null = null;
  private engineDest: MediaStreamAudioDestinationNode | null = null;
  private cableDest:  MediaStreamAudioDestinationNode | null = null;
  private freqData:   Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private cableData:  Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private offCanvas:  OffscreenCanvas | null = null;
  private offCtx:     OffscreenCanvasRenderingContext2D | null = null;
  private prevAvatar: Uint8ClampedArray | null = null;
  private timer:      ReturnType<typeof setInterval> | null = null;
  private videoEl:    HTMLVideoElement | null = null;
  private micStream:  MediaStream | null = null;
  // One self-calibrating figure - this room's silence and this customer's own loudness -
  // drives the meter, the gate and the speech detector. Nothing here needs a switch, and
  // nothing here depends on anyone understanding what a switch does.
  private gate = new VoiceGate();

  // Face-movement history and the gap between a word and the picture that answered it,
  // held in one place so the rule that decides it can be replayed offline.
  private sync = new LipSyncEstimator();
  private startedAt = 0;

  vuLevel = 0;
  cableVu = 0;
  onUpdate?: (delay: number, vu: number, measured: boolean, live: boolean, state: GateState,
              cableVu: number, reason: SyncReason) => void;

  // `mic` is a microphone this page already asked for and proved. Handing it in keeps a
  // call from opening a second one — two asks of the same device is how a pre-flight
  // check used to cost the customer the input he had just been shown working.
  // `videoEl` is null on the Voice Only tab, which mounts no picture at all: the meters and
  // the noise gate still run there, only the lip-sync figure has nothing to compare against.
  async start(videoEl: HTMLVideoElement | null, micDeviceId?: string, mic: MediaStream | null = null):
    Promise<{ engine: MediaStream; cable: MediaStream } | null> {
    this.videoEl = videoEl;
    try {
      this.micStream = mic ?? await navigator.mediaDevices.getUserMedia({
        audio: micAudioConstraints(micDeviceId, 48000),
        video: false,
      });
      const ctx = new AudioContext({ sampleRate: 48000 });
      // Left suspended, this context would starve the cable of voice while the meters
      // on screen kept moving — silence that looks like success.
      if (ctx.state !== "running") { try { await ctx.resume(); } catch { /* ignore */ } }
      const src = ctx.createMediaStreamSource(this.micStream);
      // Rumble, fans, traffic and air-conditioning all sit below the voice. Taking them
      // out here cleans both the AI's input and the cable, on top of the browser's own
      // suppression — and it matters to the timing, because a low-frequency hum looks
      // like speech starting on every single sample.
      const highpass = ctx.createBiquadFilter();
      highpass.type = "highpass"; highpass.frequency.value = 90; highpass.Q.value = 0.7;
      const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      // The default scale tops out at -30 dB, which ordinary speaking level goes past on
      // a normal microphone. Everything above it then reads the same number, so the bar
      // pins at 100% the moment you open your mouth and the gate loses the one thing it
      // needs to tell a quiet word from a shout.
      analyser.minDecibels = -90; analyser.maxDecibels = -10;
      this.freqData = new Uint8Array(analyser.frequencyBinCount);
      // The gate sits on the outgoing copy only. It closes what your callers hear, never what
      // the AI hears: a level detector can be wrong about a quiet voice or a loud one-off sound,
      // and when it is, gating the AI's ears silences the avatar completely - the one failure no
      // customer can be talked around. What the AI gets is turned DOWN while it is not his voice,
      // which cannot mute a call however wrong it is, and the decision is taken before the hold so
      // it travels with the same copy of your voice the delay then moves.
      const gateNode = ctx.createGain(); gateNode.gain.value = 1;
      const engineNode = ctx.createGain(); engineNode.gain.value = 1;
      // Your voice, undelayed, to the AI: it starts reacting as you speak.
      const engineDest = ctx.createMediaStreamDestination();
      // The same voice gated and held back, to the virtual microphone: the copy callers and OBS
      // hear, and the only thing the measured delay is applied to.
      const delay = ctx.createDelay(MAX_HOLD + 0.5); delay.delayTime.value = this.sync.hold;
      const cableDest = ctx.createMediaStreamDestination();
      // Measured on the far side of the gate and the hold, so the second bar on the card is the
      // signal OBS is actually handed and not the sound of the room.
      const cableAnalyser = ctx.createAnalyser(); cableAnalyser.fftSize = 512;
      cableAnalyser.minDecibels = -90; cableAnalyser.maxDecibels = -10;
      this.cableData = new Uint8Array(cableAnalyser.frequencyBinCount);
      src.connect(highpass);
      highpass.connect(analyser);          // measurement only - it feeds nothing that plays
      highpass.connect(engineNode); engineNode.connect(engineDest);
      highpass.connect(gateNode);
      gateNode.connect(delay); delay.connect(cableDest); delay.connect(cableAnalyser);
      this.audioCtx = ctx; this.analyser = analyser; this.gateNode = gateNode; this.delayNode = delay;
      this.engineNode = engineNode; this.cableAnalyser = cableAnalyser;
      this.engineDest = engineDest; this.cableDest = cableDest;
      this.offCanvas = new OffscreenCanvas(FRAME_W, FRAME_H);
      this.offCtx = this.offCanvas.getContext("2d")!;
      this.startedAt = performance.now() / 1000;
      this.timer = setInterval(() => this._tick(), WINDOW_MS);
      return { engine: engineDest.stream, cable: cableDest.stream };
    } catch { return null; }
  }

  // Movement inside the avatar's mouth band since the previous sample, and whether there was a picture
  // to compare at all. The last frame is forgotten whenever the picture goes, so the first frame of a
  // reconnect is compared with a frame of the same picture and not with the moment it died - which is
  // the largest movement a call will ever show.
  private _motion(el: HTMLVideoElement | null): { motion: number; picture: boolean } {
    if (!this.offCtx || !el || el.paused || el.readyState < 2) {
      this.prevAvatar = null;
      return { motion: 0, picture: false };
    }
    try {
      this.offCtx.drawImage(el, 0, 0, FRAME_W, FRAME_H);
      const frame = this.offCtx.getImageData(0, 0, FRAME_W, FRAME_H).data;
      const motion = bandMotion(frame, this.prevAvatar, AVATAR_BAND);
      this.prevAvatar = new Uint8ClampedArray(frame);
      return { motion, picture: true };
    } catch { return { motion: 0, picture: false }; }
  }

  private _tick() {
    // No picture is not no meter: a Voice Only call has no element to watch, and its meters,
    // its gate and its cable levels are measured from the microphone exactly as a picture's are.
    if (!this.analyser) return;
    this.analyser.getByteFrequencyData(this.freqData);
    // Only the band a voice lives in. Room noise is broadband, and mixing it with the
    // voice leaves almost nothing to tell your words apart from an empty room.
    const level = voiceBandLevel(this.freqData, 48000);
    this.gate.update(level, WINDOW_MS / 1000);
    this.vuLevel = this.gate.vu(level);
    if (this.audioCtx) {
      const now = this.audioCtx.currentTime;
      // His words travel out unless the gate is shut; the AI hears them either way, just further
      // away. Both err towards being heard, because a wrongly-shut microphone is a silent call.
      if (this.gateNode) this.gateNode.gain.setTargetAtTime(this.gate.muted ? 0 : 1, now, GATE_RAMP);
      if (this.engineNode) {
        this.engineNode.gain.setTargetAtTime(this.gate.armed && !this.gate.talking ? ENGINE_DUCK : 1, now, GATE_RAMP);
      }
    }
    // What the callers get, after the gate and after the hold, on the same scale as his own bar.
    if (this.cableAnalyser) {
      this.cableAnalyser.getByteFrequencyData(this.cableData);
      this.cableVu = this.gate.vu(voiceBandLevel(this.cableData, 48000));
    }
    // The two series the figure comes from: how loud he is and how much the avatar's mouth is moving.
    // His own camera is not part of this - the engine animates the mouth from his voice, so his voice is
    // the witness that cannot be a coincidence, and the call needs no pause in it to be measured. The
    // level is the raw microphone, before the gate: a hold that depended on the gate's decision would be
    // timed against a copy of the voice that never reaches anyone.
    const avatar = this._motion(this.videoEl);
    const held = this.sync.hold;
    this.sync.push({
      motion: avatar.motion,
      voice: this.vuLevel / 100,
      picture: avatar.picture,
      at: performance.now() / 1000 - this.startedAt,
    });
    // The cable moves when the figure moves, and for no other reason: a hold that is
    // re-written every sample makes the voice wobble even when nothing was learned.
    if (this.sync.hold !== held && this.delayNode && this.audioCtx) {
      this.delayNode.delayTime.setTargetAtTime(this.sync.hold, this.audioCtx.currentTime, HOLD_RAMP);
    }
    this.onUpdate?.(this.sync.hold, this.vuLevel, this.sync.measured, this.sync.live,
      gateState(this.gate), this.cableVu, this.sync.reason);
  }

  // What the cloned voice records. Not the raw microphone: a clone built from a room
  // full of television and traffic comes out carrying that noise, and there is no
  // switch anywhere that would explain it to the customer afterwards.
  getMicStream() { return this.engineDest?.stream ?? this.micStream; }

  get hold() { return this.sync.hold; }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
    this.micStream?.getTracks().forEach(track => track.stop()); this.micStream = null;
    this.engineDest = null; this.cableDest = null; this.gateNode = null;
    this.engineNode = null; this.delayNode = null; this.analyser = null!; this.cableAnalyser = null;
    this.gate.reset();
    this.sync.reset();
    this.prevAvatar = null;
    this.vuLevel = 0; this.cableVu = 0;
  }
}

// ─── Voice cloning engine ─────────────────────────────────────────────────────
// This engine lives in the pause between his words. The microphone is recorded
// continuously, its level is watched, and when he stops talking - or after a second and
// a half of talking without a breath - the piece is closed, handed to the voice service,
// and the voice that comes back is played onto the cable. One piece is ever in flight:
// while an answer is still out there the recorder simply keeps collecting, so a slow
// reply makes his words late rather than lost, and cutting on a pause means a word is
// never sliced in half by a stopwatch.

const PUMP_MS             = 60;   // how often the microphone level is looked at
const CLONE_MAX_PIECE_MS  = 1500; // ...unless he is still talking, then send it anyway
const CLONE_MIN_SPEECH_MS = 200;  // less than this is a cough, not a line worth paying for
const CLONE_IDLE_MS       = 5000; // a piece holding no speech at all is thrown away this often
// A request that never lands must not hold the pipeline shut for the rest of the call, so the
// wait has a deadline: the piece is abandoned and his next words are tried again.
const CLONE_SEND_MS       = 6000;

// A cloning call is not on air until the cloned voice has answered once, because a call
// whose voice never arrived is not the call the customer bought. The hold is bounded so a
// man who simply has not spoken yet still pays like anyone else.
const CLONE_FIRST_AIR_MS = 30_000;
// The hard end of that hold is the no-picture cut minus the round trip it takes to say so:
// the gateway closes a call whose stamp never arrived, and it reads the stamp from the server
// side, so a working call must never be the one that is still waiting on its voice.
const CLONE_AIR_HARD_MS  = PICTURE_GIVE_UP_MS - 5_000;

/**
 * The microphone, asked for and proven before anything is booked.
 *
 * A clone that is handed a dead or denied input records silence for the whole call: the
 * picture moves, the meter runs, and nobody hears him. This costs no minutes, takes one
 * permission answer, and the stream it returns is the very one the call then uses.
 */
async function openMicrophone(deviceId: string | undefined): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: micAudioConstraints(deviceId, 48000), video: false,
  });
  const track = stream.getAudioTracks()[0];
  if (!track || track.readyState !== "live") {
    stream.getTracks().forEach(t => t.stop());
    throw new Error("microphone produced no live input");
  }
  return stream;
}

/**
 * The free ask that proves the voice service will answer this account, before a call is
 * booked: it lists the voices. No lease, no inference, nothing billed. Null means the door
 * opened; anything else is the reason it did not.
 */
async function voiceDoorReason(): Promise<string | null> {
  try {
    const res = await gateway.voice("/v1/voices", undefined, { method: "GET" });
    if (res.ok) return null;
    const j = await res.json().catch(() => null) as { reason?: string } | null;
    return j?.reason || "upstream_key";
  } catch { return "upstream_key"; }
}

class VoiceCloningEngine {
  private recorder:   MediaRecorder | null = null;
  private audioCtx:   AudioContext  | null = null;
  private nextPlayAt = 0;
  private running    = false;
  private videoDelay = FALLBACK_HOLD;
  private analyserNode: AnalyserNode | null = null;
  private voiceBus: GainNode | null = null;
  private outDest: MediaStreamAudioDestinationNode | null = null;
  private monitorGain: GainNode | null = null;
  private monitored = false;
  // The microphone watched, not forwarded. Nothing audible hangs off this tap: it exists
  // so the engine can tell his voice from his room and know when he has finished speaking.
  private inSrc:      MediaStreamAudioSourceNode | null = null;
  private inAnalyser: AnalyserNode | null = null;
  private inFreq:     Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private gate = new VoiceGate();
  private pump: ReturnType<typeof setInterval> | null = null;
  // One piece at a time, and no words dropped while one is out: the recorder just keeps
  // gathering until the answer lands.
  private busy = false;
  private pieceMs  = 0;
  private speechMs = 0;

  call       = null as null | ((path: string, body: FormData) => Promise<Response>);
  voiceId    = BUILTIN_VOICES[0].id;
  onVu?:     (level: number) => void;
  onError?:  (msg: string) => void;
  // Reports whether the player that carries the cloned voice is actually running. The
  // meter below the panel reads through this, so silence can never look like sound.
  playerLive?: () => boolean;
  // When his microphone last held a real word, and when cloned audio last came back. A
  // clone is only dead if he spoke and nothing answered him: a call where he has simply
  // not talked yet is silence by agreement, not a fault, and must never put his raw
  // microphone back on the cable in the middle of a pause.
  spokeAt    = 0;
  answeredAt = 0;
  // What the service has been handed and what it has sent back, in the four figures the
  // readout on the panel shows. They are counted here rather than guessed from the meters,
  // because a bar can move on a chunk that never left this app.
  piecesSent = 0;
  piecesBack = 0;
  secondsIn  = 0;
  secondsOut = 0;
  lastAnswerMs = 0;
  private sentAt = 0;
  // Fires once, on the first cloned audio that actually reaches the cable. A cloning call
  // is not on air before that, so this is what releases the held money clock.
  onFirstAnswer?: () => void;

  alive(graceSeconds: number): boolean {
    if (this.answeredAt >= this.spokeAt) return true;
    return Date.now() - this.spokeAt < graceSeconds * 1000;
  }

  setVideoDelay(d: number) { this.videoDelay = d; }

  // Send the cloned voice to the local speakers as well as the cable. Loudspeakers
  // + open mic can feed it back into the call; headphones are always safe.
  setMonitor(on: boolean) {
    if (on === this.monitored) return;
    this.monitored = on;
    if (!this.audioCtx) return;
    // A fault here used to take the whole window down, so nothing in this path is
    // allowed to throw out of the call.
    try {
      if (on) {
        if (!this.voiceBus) return;
        if (this.audioCtx.state === "suspended") void this.audioCtx.resume();
        if (!this.monitorGain) {
          this.monitorGain = this.audioCtx.createGain();
          this.voiceBus.connect(this.monitorGain);
        }
        this.monitorGain.disconnect();
        this.monitorGain.connect(this.audioCtx.destination);
      } else if (this.monitorGain) {
        this.monitorGain.disconnect();
      }
    } catch { /* monitor is a nicety; the call is not */ }
  }

  async start(micStream: MediaStream) {
    if (this.running) return;
    this.running   = true;
    this.spokeAt   = 0;
    this.answeredAt = 0;
    this.piecesSent = 0; this.piecesBack = 0;
    this.secondsIn = 0; this.secondsOut = 0; this.lastAnswerMs = 0;
    this.audioCtx = new AudioContext();
    // Constructed outside the click's user activation, so this context can come up
    // suspended. Left alone, every chunk decodes, every meter moves, and nothing
    // anywhere is audible — including the cable.
    if (this.audioCtx.state !== "running") { try { await this.audioCtx.resume(); } catch { /* ignore */ } }
    this.outDest  = this.audioCtx.createMediaStreamDestination();
    this.nextPlayAt = this.audioCtx.currentTime + this.videoDelay + 0.1;

    // The meter reads the voice that is PLAYING, never the microphone that fed it. This
    // block is labelled "Cloned Voice Output", and a wave drawn from the input could move
    // while the cable was carrying nothing at all - or sit flat while the cloned voice was
    // playing perfectly. It lives in the audio context above, the one that has been woken
    // and that the player uses, so it can never be asleep on its own.
    this.analyserNode = this.audioCtx.createAnalyser();
    this.analyserNode.fftSize = 256;
    // The cable's destination node has zero outputs of its own, so tapping it directly
    // throws and the call never starts. Everything the clone plays goes through this
    // gain instead: one copy feeds the cable, another feeds the meter.
    this.voiceBus = this.audioCtx.createGain();
    this.voiceBus.connect(this.outDest);
    this.voiceBus.connect(this.analyserNode);

    // Watching his level, from the very microphone the recorder below is already carrying.
    // Nothing audible hangs off this tap. It exists so the engine can tell his voice from
    // his room, which is the only way to know when a sentence has ended - and the only way
    // to know that an empty room is not a broken clone.
    this.inSrc = this.audioCtx.createMediaStreamSource(micStream);
    this.inAnalyser = this.audioCtx.createAnalyser();
    this.inAnalyser.fftSize = 512;
    this.inAnalyser.minDecibels = -90; this.inAnalyser.maxDecibels = -10;
    this.inFreq = new Uint8Array(this.inAnalyser.frequencyBinCount);
    this.inSrc.connect(this.inAnalyser);
    this.gate.reset();

    const chunkMs = 2000;
    const chunks: Blob[] = [];
    this.recorder = new MediaRecorder(micStream, { mimeType: "audio/webm;codecs=opus" });

    this.recorder.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data); };
    this.recorder.onstop = () => {
      if (!this.running) return;
      const blob  = new Blob(chunks.splice(0), { type: "audio/webm" });
      const worth = blob.size > 0 && this.speechMs >= CLONE_MIN_SPEECH_MS;
      // A piece of nothing but his room never leaves the app: it would be billed as
      // airtime and would come back as nothing to hear.
      this.pieceMs = 0; this.speechMs = 0;
      // The next piece starts gathering immediately, before this one has been answered, so
      // nothing he says while the service is thinking is lost.
      this.recorder!.start(chunkMs);
      setTimeout(() => { if (this.running && this.recorder?.state === "recording") this.recorder.requestData(); }, chunkMs);
      if (worth) void this._process(blob);
      else this.busy = false;
    };
    this.recorder.start(chunkMs);
    setTimeout(() => { if (this.running && this.recorder?.state === "recording") this.recorder.requestData(); }, chunkMs);
    this.pump = setInterval(() => this._pumpTick(PUMP_MS), PUMP_MS);
  }

  private _pumpTick(dtMs: number) {
    if (!this.running || !this.inAnalyser) return;
    this.inAnalyser.getByteFrequencyData(this.inFreq);
    const level = voiceBandLevel(this.inFreq, this.audioCtx?.sampleRate ?? 48000);
    this.gate.update(level, dtMs / 1000);
    this.pieceMs += dtMs;
    if (this.gate.talking) { this.spokeAt = Date.now(); this.speechMs += dtMs; }
    // One answer at a time. While one is out there the piece simply keeps growing, which
    // makes his words late rather than dropped - and a dropped word is a caller who heard
    // half a sentence.
    if (this.busy) return;
    // His own detector decides when a sentence is over, so a word is never sliced by a
    // stopwatch and a pause in the conversation is never read as a fault.
    if (this.speechMs >= CLONE_MIN_SPEECH_MS &&
        (!this.gate.talking || this.pieceMs >= CLONE_MAX_PIECE_MS)) { this._cut(); return; }
    if (this.speechMs === 0 && this.pieceMs >= CLONE_IDLE_MS) this._cut();
  }

  // Close the piece. The stop handler restarts the recorder and does the sending.
  private _cut() {
    this.busy = true;
    try { this.recorder?.stop(); } catch { this.busy = false; }
  }

  // The service answers faster on raw samples than on a compressed file, and it promises
  // only the input formats it names, so the piece is rebuilt here as the raw 16-bit mono
  // 16 kHz stream its reference describes rather than a browser recording container nobody
  // has promised to read.
  private async _toPcm16k(blob: Blob): Promise<ArrayBuffer | null> {
    if (!this.audioCtx) return null;
    const decoded = await this.audioCtx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const frames = Math.max(1, Math.ceil(decoded.duration * rate));
    const off = new OfflineAudioContext(1, frames, rate);
    const node = off.createBufferSource(); node.buffer = decoded; node.connect(off.destination); node.start();
    const samples = (await off.startRendering()).getChannelData(0);
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out.buffer;
  }

  // One piece of his voice, handed to the service with a deadline on the answer. Without the
  // deadline a single lost request on a flaky connection would keep the pipeline busy forever,
  // which means no cloned voice for the rest of the call.
  private async _send(form: FormData): Promise<Response> {
    const call = this.call!(`/v1/speech-to-speech/${this.voiceId}/stream`, form);
    const deadline = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("the voice service took too long to answer")), CLONE_SEND_MS);
    });
    return Promise.race([call, deadline]);
  }

  private async _process(blob: Blob) {
    if (!this.running || !this.audioCtx || !this.call || !this.voiceId) { this.busy = false; return; }
    try {      const pcm = await this._toPcm16k(blob);
      if (!pcm || !this.running) return;
      // 16-bit mono at 16 kHz, which is what the piece was rebuilt as before it left.
      this.piecesSent += 1;
      this.secondsIn += pcm.byteLength / 2 / 16000;
      const form = new FormData();
      form.append("audio", new Blob([pcm], { type: "application/octet-stream" }), "chunk.pcm");
      form.append("file_format", "pcm_s16le_16");
      form.append("model_id", "eleven_multilingual_sts_v2");
      form.append("voice_settings", JSON.stringify({ stability: 0.5, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true }));
      this.sentAt = performance.now();
      const res = await this._send(form);
      if (!res.ok) { console.warn(`[voice] engine returned HTTP ${res.status}`); this.onError?.(endReasonMessage("upstream_key")); return; }
      const buf = await res.arrayBuffer();
      if (!this.running || !this.audioCtx) return;
      if (this.audioCtx.state !== "running") { try { await this.audioCtx.resume(); } catch { /* ignore */ } }
      const decoded = await this.audioCtx.decodeAudioData(buf);
      this.piecesBack += 1;
      this.secondsOut += decoded.duration;
      this.lastAnswerMs = Math.round(performance.now() - this.sentAt);
      const playAt = Math.max(this.audioCtx.currentTime + this.videoDelay, this.nextPlayAt);
      const src = this.audioCtx.createBufferSource();
      src.buffer = decoded; src.connect(this.voiceBus!); src.start(playAt);
      // Answered: the watchdog that decides whether this call is still worth running is
      // reset here, the moment real cloned audio is on its way to the cable. The first
      // time it happens is also the moment the call goes on air and starts being metered.
      const first = this.answeredAt === 0;
      this.answeredAt = Date.now();
      if (first) this.onFirstAnswer?.();
      this.nextPlayAt = playAt + decoded.duration;
      // Level is read through the player, not off these samples. Measuring the audio
      // that merely arrived drew a dancing wave over total silence whenever the engine
      // was asleep, which is how a dead cable got mistaken for a working one.
      const live = this.playerLive ? this.playerLive() : true;
      if (!live) { this.onVu?.(0); return; }
      const data = decoded.getChannelData(0);
      let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      this.onVu?.(Math.min(100, Math.sqrt(sum / data.length) * 300));
    } catch (e) {
      if (this.running) this.onError?.(toUserMessage(e, "Voice processing error"));
    } finally {
      this.busy = false;
    }
  }

  getAnalyser(): AnalyserNode | null { return this.analyserNode; }

  getOutputStream(): MediaStream | null { return this.outDest?.stream ?? null; }

  stop() {
    this.running = false;
    if (this.pump) { clearInterval(this.pump); this.pump = null; }
    this.busy = false;
    this.outDest = null;
    this.voiceBus = null;
    this.monitorGain = null; this.monitored = false;
    try { this.recorder?.stop(); } catch { /* ignore */ }
    this.recorder = null;
    try { this.inSrc?.disconnect(); } catch { /* ignore */ }
    this.inSrc = null; this.inAnalyser = null;
    try { this.audioCtx?.close(); } catch { /* ignore */ }
    this.audioCtx = null; this.analyserNode = null;
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

async function _startVideoSession(token: string, localStream: MediaStream, onRemote: (s: MediaStream) => void, onConnectionState: (state: RTCPeerConnectionState) => void, onDisconnect: (why: string) => void, prompt: string, refB64: string | null): Promise<VideoSession> {
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
        localStream.getTracks().forEach(track => pc!.addTrack(track, localStream));
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
      // The code is the only thing that distinguishes a service that ran out of patience from
      // a network that dropped, and this page has no other record of it.
      else if (ev.code !== 1000) onDisconnect(`code ${ev.code}${ev.reason ? ` — ${_engineWords(ev.reason)}` : ""}`);
    };
  });
}

// ─── Second video pipeline (trial accounts) ─────────────────────────────────
// Same job as _startVideoSession, but the peer connection and its signalling live
// inside the pipeline's own SDK. Everything the rest of this page needs — a remote
// MediaStream, an RTCPeerConnectionState-shaped callback, close(), send() — is
// rebuilt here from the SDK's events, so the pump that feeds the virtual camera,
// the prompt updates and the teardown code never learn there is more than one
// engine. The one rule: nothing here may put a provider name on the screen.
/**
 * One readable line out of whatever the video pipeline answered with: an Error, a bare string,
 * or the close event's own object carrying a code and a reason. Whitespace flattened and capped,
 * because this goes into a log column and a customer's file, not onto a screen.
 */
function _engineWords(e: unknown): string {
  let s: string;
  if (e instanceof Error) s = `${e.name}: ${e.message}`;
  else if (typeof e === "string") s = e;
  else {
    try { s = JSON.stringify(e) ?? String(e); } catch { s = String(e); }
  }
  return s.replace(/\s+/g, " ").slice(0, 280);
}

async function _startTrialVideoSession(
  token: string, localStream: MediaStream, onRemote: (s: MediaStream) => void,
  onConnectionState: (state: RTCPeerConnectionState) => void, onDisconnect: (why: string) => void,
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
    // The engine's own wording names the service and its hostnames, so it may never be put on
    // the screen — but throwing it away entirely was worse: the sentence the customer reads
    // points at his administrator, who could not see anything at all. Only this branch's
    // message reaches the panel and the log file, never a customer's screen, because the toast
    // is built from the failure's reason code and not from this text.
    console.warn("[video] could not start the call:", opened.err);
    throw new Error(`${APP}: could not start the call (${_engineWords(opened.err)})`);
  }
  const rc = opened.client;

  // Only a session the server finished on purpose may end the call. A "error" event
  // is the engine reporting trouble while keeping the room open and retrying, and
  // treating it as a hang-up turned a recoverable blip into a dead stream a few
  // seconds into the trial. Both are logged with their reason, because nothing here
  // is allowed to put a provider name on the screen and a silent teardown cannot be
  // diagnosed afterwards.
  rc.on("sessionEnded", (e: { reason?: string } | undefined) => {
    const why = e?.reason ?? "no reason given";
    console.warn("[video] the call ended:", why);
    onDisconnect(why);
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
  const [activeTab, setActiveTab] = useState<TabId>(() => savedTab() ?? "video-only");

  // ── Portrait / Landscape mode (persisted) ──────────────────────────────────
  const [portraitMode, setPortraitMode] = useState<boolean>(() => {
    try { return localStorage.getItem("ss_portrait_mode") === "1"; } catch { return false; }
  });
  // The frame pump is a dep-free self-chaining setTimeout loop, so it reads the
  // mode through a ref instead of closing over state.
  const portraitRef    = useRef(portraitMode);
  const togglePortrait = useCallback(() => {
    setPortraitMode(v => {
      const next = !v;
      // Set the ref here, not only in an effect: the pump must pick the new layout
      // up on its very next frame instead of waiting for a render pass.
      portraitRef.current = next;
      try { localStorage.setItem("ss_portrait_mode", next ? "1" : "0"); } catch { /**/ }
      return next;
    });
  }, []);
  // Covers a mode restored from localStorage on load, and any other state change.
  useEffect(() => { portraitRef.current = portraitMode; }, [portraitMode]);

  // ── Stream state ───────────────────────────────────────────────────────────
  const [connStatus, setConnStatus]   = useState<"idle"|"connecting"|"connected"|"reconnecting">("idle");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStarting, setIsStarting]  = useState(false);
  // The mark a trial puts on the picture, said two ways: the card he reads once, then the
  // ribbon that stays at the top of his video for as long as his calls run on free minutes.
  const [trialCard, setTrialCard]     = useState(false);
  const [trialRibbonOff, setTrialRibbonOff] = useState(false);
  // Nothing may outlive the call it was about: when the page is back to idle, the card goes with
  // it, so a call that failed never leaves a popup sitting over the screen it failed on.
  useEffect(() => {
    if (!isStarting && !isStreaming && connStatus === "idle") setTrialCard(false);
  }, [isStarting, isStreaming, connStatus]);
  const [isClosing, setIsClosing]    = useState(false);
  const [connStep, setConnStep]       = useState<"mic"|"auth"|"engine"|"voice"|"retry"|null>(null);
  // Seconds left on a wait the gateway announced for this machine. Null when nobody has
  // asked us to hold, so the overlay keeps its old wording for a plain retry.
  const [pacingSeconds, setPacingSeconds] = useState<number | null>(null);
  // Seconds left before this machine is allowed to press Start again, after a call that never
  // showed a picture. Null while nothing is being held. The button wears the number, so the
  // wait the customer was told about is the wait he can see counting down - and the app never
  // re-dials on his behalf while it runs.
  const [holdSeconds, setHoldSeconds] = useState<number | null>(null);
  const [elapsed, setElapsed]         = useState(0);
  // Frames-per-second readout, shown below the video panel. Never on the panel:
  // that frame is what OBS and the calling apps capture. Updated straight into
  // these spans, never through state - see the readout effect below.
  const fpsCamRef  = useRef<HTMLSpanElement | null>(null);
  const fpsAiRef   = useRef<HTMLSpanElement | null>(null);
  const fpsHintRef = useRef<HTMLSpanElement | null>(null);

  // ── Devices ───────────────────────────────────────────────────────────────
  const [cameras, setCameras]             = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics]                   = useState<MediaDeviceInfo[]>([]);
  // Per-tab: each tab keeps its own camera/mic selection (strict tab isolation).
  const [selectedCamId, setSelectedCamId] = usePerTabState<string>(activeTab, "");
  const [selectedMicId, setSelectedMicId] = usePerTabState<string>(activeTab, "");
  const [cameraReady, setCameraReady]     = useState(false);

  // The pick read synchronously. `enumerateDevices` is called from callbacks that
  // were created before React committed the new id, so reading state there saw the
  // old value and snapped the chip back to the first device on every switch — the
  // bar "worked for a while and then stopped". These refs carry the truth the
  // moment the drop-down fires.
  const camSelRef = useRef(selectedCamId);
  const micSelRef = useRef(selectedMicId);
  camSelRef.current = selectedCamId;
  micSelRef.current = selectedMicId;
  const chooseCam = useCallback((id: string) => { camSelRef.current = id; setSelectedCamId(id); }, [setSelectedCamId]);
  const chooseMic = useCallback((id: string) => { micSelRef.current = id; setSelectedMicId(id); }, [setSelectedMicId]);

  // ── Video style ───────────────────────────────────────────────────────────
  // Per-tab: prompt/style/reference image uploaded in one tab must not appear in another.
  const [selectedStyle, setSelectedStyle] = usePerTabState<StyleId>(activeTab, "hyper-real");
  const [customPrompt, setCustomPrompt]   = usePerTabState<string>(activeTab, "");
  const [refImageB64, setRefImageB64]     = usePerTabState<string|null>(activeTab, null);
  const [refImagePreview, setRefImagePreview] = usePerTabState<string|null>(activeTab, null);

  // ── Audio sync ────────────────────────────────────────────────────────────
  const [syncDelay, setSyncDelay]     = useState(FALLBACK_HOLD);
  const [syncMeasured, setSyncMeasured] = useState(false);
  const [syncLive, setSyncLive]       = useState(false);
  const [syncReason, setSyncReason]   = useState<SyncReason>("waiting");
  const [audioActive, setAudioActive] = useState(false);

  // ── The microphone card ───────────────────────────────────────────────────
  // One bar, one plain sentence, and it works before any call: this is where he can see that
  // his microphone is being heard without spending a minute to find out. It is painted straight
  // into the DOM rather than through page state, because a fast state tick on this page has
  // remounted the device lists and closed the camera drop-down underneath him.
  // The level bars are painted by the audio pipeline, not by React state. Design 2 shows
  // them on the control bar and the cards show them again, so every mounted bar registers
  // itself and one paint reaches all of them.
  const micBars = useRef<Set<HTMLDivElement>>(new Set());
  const micWords = useRef<Set<HTMLSpanElement>>(new Set());
  const addMicBar = useCallback((el: HTMLDivElement | null) => { if (el) micBars.current.add(el); }, []);
  const addMicWord = useCallback((el: HTMLSpanElement | null) => { if (el) micWords.current.add(el); }, []);
  const paintMic = useCallback((pct: number, state: GateState) => {
    const w = Math.max(0, Math.min(100, Math.round(pct))) + "%";
    const word = t(MIC_CARD_WORDS[state]);
    micBars.current.forEach(b => { if (!b.isConnected) micBars.current.delete(b); else b.style.width = w; });
    micWords.current.forEach(s => { if (!s.isConnected) micWords.current.delete(s); else s.textContent = word; });
  }, []);
  // The held copy gets its own bar, painted the same way: the number on screen has to be the
  // signal OBS is handed, or the card only shows the sound of the room.
  const cableBars = useRef<Set<HTMLDivElement>>(new Set());
  const addCableBar = useCallback((el: HTMLDivElement | null) => { if (el) cableBars.current.add(el); }, []);
  const paintCable = useCallback((pct: number) => {
    const w = Math.max(0, Math.min(100, Math.round(pct))) + "%";
    cableBars.current.forEach(b => { if (!b.isConnected) cableBars.current.delete(b); else b.style.width = w; });
  }, []);
  const [micChecking, setMicChecking] = useState(false);

  // ── Noise cancellation ────────────────────────────────────────────────────
  // There is deliberately no switch here. Most customers never look for one, never
  // understand it and never turn it on, so the app now works out this room's silence
  // and this person's own loudness by itself and holds the microphone to that.

  // ── Voice cloning ───────────────────────────────────────────────────────────
  // Per-tab: the voice chosen on the picture-and-voice tab must not leak into the voice-only
  // tab (and vice versa) — they are two calls a customer may want to sound different on.
  // There is no on/off switch any more: the tab he is standing on is the switch.
  const [vcActive, setVcActive]           = useState(false);
  const [vcVu, setVcVu]                   = useState(0);
  // Empty on purpose. A preset picked for him would put a voice on his line that he never
  // chose, and the call would bill before he noticed — so the list opens on "Choose a voice"
  // and no cloning call starts until he answers it.
  const [vcVoiceId, setVcVoiceId]         = usePerTabState<string>(activeTab, "");
  const [savedVoices, setSavedVoices]     = useState<SavedVoice[]>(() => getSavedVoices());
  const [uploadingVoice, setUploadingVoice] = useState(false);
  const [uploadVoiceName, setUploadVoiceName] = useState("");
  const [vcAnalyser, setVcAnalyser]       = useState<AnalyserNode | null>(null);

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
  // Off until the tab he is standing on opens a call of its own, and back off when that call ends.
  // The machine holds ONE fake camera and ONE cable, so a switch may only be lit for a call that is
  // really using them - which is why these two records are kept per tab, the same way each tab keeps
  // its own camera, microphone, prompt and look. Nothing is remembered between visits: a switch that
  // is off until a call starts has nothing to remember.
  const [camOnTab, setCamOnTab] = useState<Record<TabId, boolean>>(
    { "video-audio": false, "video-only": false, "audio-only": false });
  const [micOnTab, setMicOnTab] = useState<Record<TabId, boolean>>(
    { "video-audio": false, "video-only": false, "audio-only": false });
  const vcamEnabled  = camOnTab[activeTab];
  const audioRouteOn = micOnTab[activeTab];
  // The tab whose call is holding the two devices right now. The dial writes it, and the call ending
  // clears that tab alone - whichever tab he happens to be looking at by then.
  const broadcastOwnerRef = useRef<TabId>(activeTab);
  // Both writers name the tab they mean and close over nothing, so their identity never changes. A
  // tab change must not rebuild the functions that hold a running call.
  const setCamFor = useCallback((tab: TabId, on: boolean) => setCamOnTab(p => ({ ...p, [tab]: on })), []);
  const setMicFor = useCallback((tab: TabId, on: boolean) => setMicOnTab(p => ({ ...p, [tab]: on })), []);
  // teardownStream has to keep ONE stable identity: the unmount effect below runs the whole call-down
  // whenever its dependency changes, so a release that moves with the device list would tear down a
  // live call every time a webcam was plugged in. The release is reached through this ref instead.
  const releaseBroadcastRef = useRef<(tab: TabId) => void>(() => {});
  const [vcamSupported, setVcamSupported] = useState(true);
  const [vcamReady, setVcamReady]         = useState(false);
  // Why a switch the dial tried to light is showing Off. Only the silent passes set it, so a
  // deliberate press off stays the plain "Off" line he already knows.
  const [broadcastBlocked, setBroadcastBlocked] = useState<"" | "no-cable" | "no-sink">("");
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
  // Offscreen twin of the camera preview. The picture-in-picture box is hidden in
  // portrait mode, so this is what keeps the camera stream presenting frames for
  // the readout to count.
  const camCountRef     = useRef<HTMLVideoElement | null>(null);
  // Plays the cloned voice; routed to the cable alongside the microphone.
  const cloneAudioRef   = useRef<HTMLAudioElement | null>(null);
  // Plays the microphone (or its delayed twin) so the cable can carry it. Silent on
  // the speakers: it only ever holds a stream while routing is on.
  const micRouteRef     = useRef<HTMLAudioElement | null>(null);
  // The mic stream handed to the cable while a call runs, kept so a toggle mid-call
  // can re-attach it without opening a second microphone.
  const micRouteStreamRef = useRef<MediaStream | null>(null);
  const localStreamRef  = useRef<MediaStream|null>(null);
  const videoSessionRef = useRef<VideoSession|null>(null);
  // Open lease id: heartbeat/endCall live on the gateway, this mirrors it for cleanup.
  const sessionIdRef    = useRef<string|null>(null);
  // Did this machine's own hand close the call? Set by the Stop control and cleared when a new
  // lease opens, so the teardown can only ever report it for the call it belongs to. Nothing
  // else in the page reads it: it is written once, on the way out, and it decides one word in
  // the record — whether he stopped the call or the call was stopped on him.
  const stoppedByHandRef = useRef(false);
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
  // The live answer to "is a call running", for the paths that re-enter Start from inside a
  // teardown — the OBS cable asking for its call back, and the one press that swaps a voice
  // call for a picture call. Read from state there, the value is the one from before the call
  // closed, and the restart silently refused itself.
  const streamingRef    = useRef(false);
  // Set when he presses Cancel, or leaves the page, during the pause between two asks
  // for a call. Without it a start he turned down would quietly open on its own.
  const startCancelRef  = useRef(false);
  // Live-camera restart handles used by enumerateDevices auto-correct.
  const startCameraRef   = useRef<((deviceId?: string) => Promise<void>) | null>(null);
  const cameraReadyRef   = useRef(false);
  // Virtual-camera frame pump handles.
  const vcamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const vcamTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vcamOnRef     = useRef(false);
  // Whether the call in flight was opened with cloning. Read by the money clock before the
  // engine object exists, because the picture can reach the screen first.
  const cloneThisCallRef = useRef(false);
  // The meter held while a cloning call waits for its first cloned answer.
  const airHoldRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The instant the AI picture first painted on this call. Not the same thing as the money
  // stamp: a cloning call deliberately holds that stamp until the cloned voice answers, and a
  // call whose picture arrived at 20 seconds is a working call even while it waits. This is
  // the only honest answer to "did he see anything".
  const firstFrameRef = useRef<number | null>(null);
  // The three signals that decide what a blank screen actually means, gathered during the call
  // by the code that already had them: the frame counter below the preview, the transport's own
  // state, and the moment the line handed this computer a stream. Both are cleared when a call
  // opens rather than when one closes, so what they say is about the call being given up on.
  const camCounterRanRef = useRef(false);
  const camFedFrameRef   = useRef(false);
  const lineConnectedRef = useRef(false);
  // Whether this call ever painted a frame. The give-up signals above are cleared when a call
  // opens rather than when one closes, so a failure partway through a working call still has to
  // be able to tell itself apart from a call that was blank from the start.
  const paintedRef       = useRef(false);
  // The wait announced for this machine, as an instant rather than a number, so a re-render
  // mid-count never re-arms it and a press that arrives during it can be refused on the spot.
  const holdUntilRef = useRef<number | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The sentence that belongs to the wait being counted, for the one path that can still ask
  // for a call by itself: the OBS cable reconnect.
  const holdMsgRef = useRef<string | null>(null);

  const credsMissing = !account.signedIn || !hasMinutes(account, modalityForTab(activeTab));
  // Asked of an account already known to be signed in, where the empty bucket is the only way
  // this reads as no. The cloning card says "ask your administrator for minutes" rather than
  // walking him off to the sign-in page.
  const voiceKeySet = account.signedIn && hasMinutes(account, modalityForTab(activeTab));

  // ─── Who may clone a voice ───────────────────────────────────────────────────
  // Two of the three tabs clone a voice, and two separate things can say no: the administrator's
  // door on the account, and whether this account has ever paid. There is no third say — the page
  // used to carry its own switch, and that switch governed only one of the two Start presses that
  // shared the tab, so a call the customer believed was off ran and billed. One tab, one press,
  // one door now. A free trial minute buys a picture, never a cloned voice: every answer from the
  // cloning service costs the seller real money.
  const comboTab = activeTab === "video-audio";
  const voiceTab = activeTab === "audio-only";
  // A cloning tab of either kind: it needs a voice, and it stands behind a cloning door.
  const cloneTab = comboTab || voiceTab;
  const mayClone = account.signedIn && account.paid && cloneOpen(account);
  const mayVoice = account.signedIn && account.paid && voiceCloneOpen(account);
  // The picture-and-voice call needs the wider door; the voice-alone call only needs the voice
  // one open, and that is his middle position — the video-with-voice tab stays shut under it.
  // The Video Call tab belongs to nobody's switch: it clones nothing.
  const mayUseTab = (id: TabId) => id === "video-audio" ? mayClone : id === "audio-only" ? mayVoice : true;
  const cloneLocked = cloneTab && !mayUseTab(activeTab);
  const cloneNeedsPaid = cloneTab && account.signedIn && !account.paid;
  // The tab stays readable and every control in it is shown — greyed, and answering to
  // nothing. A customer who cannot see what he is missing has no reason to ask for it.
  const cloneDead = cloneLocked || cloneNeedsPaid;

  // Whether the call this tab dials is built on a cloned voice. It is what the press proves
  // before it asks for a lease: his microphone reaching the app, and the voice service
  // answering at all. The Video Call tab needs neither, because it sends his own voice.
  const needsVoice = cloneTab;

  // ─── What stands between this tab and a call ────────────────────────────────
  // One press per tab, so one short list of reasons — and the first thing on it is the voice
  // itself. A cloning call with no voice chosen would go out with a preset the customer never
  // picked, which is his voice on somebody else's mouth; the gateway refuses the dial too, so
  // no metered lease can open on an empty choice.
  const noVoiceChosen = cloneTab && !vcVoiceId;
  const startBlocked =
    cloneLocked ? endReasonMessage("clone_closed")
      : cloneNeedsPaid ? endReasonMessage("clone_needs_paid_minutes")
      : noVoiceChosen ? t("Choose a voice first, or upload your own. This call goes out with a cloned voice, and none is picked yet.")
      : null;

  // The free minute is the one thing in the app that cannot be lost, and the one thing
  // customers leave sitting there: nothing about it expires, and nothing on screen said
  // so. Shown only on a bucket this tab can actually start a call from, and only while
  // the account has never held anything but the trial — a paying customer has heard it.
  const trialWaiting = account.signedIn && !account.paid && !account.live && !cloneNeedsPaid &&
    hasMinutes(account, modalityForTab(activeTab));

  // The same question asked across every bucket rather than the visible one: the tour
  // walks all three tabs, and its list of stops must not change length underneath it.
  const tourHasTrial = account.signedIn && !account.paid &&
    account.wallets.some(w => !w.unlimited && w.balance > 0);

  // ─── Walk-through ──────────────────────────────────────────────────────────
  // Every machine gets it once, from its first signed-in moment, and Settings can call
  // it back. It is not opened over a call in flight, and while it runs the tab router
  // below stands down — nothing may move the page out from under a stop.
  const [tourOpen, setTourOpen] = useState(false);
  const tourContact = useAdminContact();
  useEffect(() => {
    if (tourSeen() || !account.signedIn || account.loading || account.live) return;
    setTourOpen(true);
  }, [account.signedIn, account.loading, account.live]);
  useEffect(() => onTourRequested(() => setTourOpen(true)), []);

  // The lease pre-debits on the server, so this balance already reflects a call in
  // flight; an unlimited bucket has no trial left to talk about.
  const videoWallet = bucketFor(account, "video");
  const videoLeft = !videoWallet || videoWallet.unlimited ? null : videoWallet.balance;

  // Which tab this account belongs on is not something the balances can say any more: one pool
  // feeds all three calls, so the minutes read identically everywhere. What says it is which
  // doors the administrator left open. A trial holds only the free video minute and both cloning
  // doors shut, so it stays on the video tab it can actually dial; an account with the
  // picture-and-voice door opens on that call, and one set to voice only opens on the voice tab
  // rather than on a screen it may not use. It re-checks on every balance read rather than once,
  // because a door that opens a beat after sign-in must still route him, and it stands down the
  // moment he picks a tab himself.
  const tabChosen = useRef(false);
  useEffect(() => {
    if (tabChosen.current || account.loading || !account.signedIn || account.wallets.length === 0) return;
    if (account.live) return;
    // The walk-through moves between the tabs itself; a router that follows the account
    // would pull the page back under the stop being explained.
    if (tourOpen) return;
    // A locked tab moves him to the cloning call that IS open, or off cloning altogether.
    if (comboTab && !mayClone) { setActiveTab(mayVoice ? "audio-only" : "video-only"); return; }
    if (voiceTab && !mayVoice) { setActiveTab(mayClone ? "video-audio" : "video-only"); return; }
    if (activeTab === "video-only" && (mayClone || mayVoice) && savedTab() === null) {
      setActiveTab(mayClone ? "video-audio" : "audio-only");
    }
  }, [account, activeTab, comboTab, voiceTab, tourOpen, mayClone, mayVoice]);

  // ─── All voices merged ─────────────────────────────────────────────────────
  const allVoices = [...savedVoices.map(v => ({ id: v.id, name: `★ ${v.name}` })), ...BUILTIN_VOICES];

  // ─── Enumerate devices ─────────────────────────────────────────────────────
  // Reads the live picks from refs rather than from its own closure, so any caller —
  // the mount effect, a camera restart, a hot-plug — can run it without overwriting
  // the device the customer chose a moment ago.
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

      // Default a tab that has never picked; leave any real pick alone.
      const camId = camSelRef.current, micId = micSelRef.current;
      if (vids.length && !camId) { camSelRef.current = vids[0].deviceId; setSelectedCamId(vids[0].deviceId); }
      if (auds.length && !micId) { micSelRef.current = auds[0].deviceId; setSelectedMicId(auds[0].deviceId); }

      // Auto-correct a device that has gone away (unplugged, or an OBS Virtual
      // Camera left over from a prior install) and restart the live preview on
      // a real camera so the feed isn't permanently black.
      if (camId && vids.length && !vids.some(v => v.deviceId === camId)) {
        const nextId = vids[0].deviceId;
        camSelRef.current = nextId;
        setSelectedCamId(nextId);
        if (cameraReadyRef.current) startCameraRef.current?.(nextId);
      }
      if (micId && auds.length && !auds.some(a => a.deviceId === micId)) {
        micSelRef.current = auds[0].deviceId;
        setSelectedMicId(auds[0].deviceId);
      }
    } catch { /* ignore */ }
  }, [setSelectedCamId, setSelectedMicId]);

  useEffect(() => { enumerateDevices(); }, [enumerateDevices]);
  // A webcam or headset plugged in after the app opened has to appear in the bar.
  useEffect(() => {
    navigator.mediaDevices?.addEventListener?.("devicechange", enumerateDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", enumerateDevices);
  }, [enumerateDevices]);
  // Each tab carries its own pick, so a tab opened for the first time has to catch up.
  useEffect(() => { void enumerateDevices(); }, [activeTab, enumerateDevices]);

  // ─── Tab switch: stop stream first ─────────────────────────────────────────
  const switchTab = useCallback((tab: TabId) => {
    tabChosen.current = true;
    if (isStreaming || isStarting) {
      stoppedByHandRef.current = true;
      teardownStream();
      toast({ title: t("Stream stopped"), description: t("Switching modes.") });
    } else {
      // Walking off a tab that holds no call puts its switches back too, so the only lit pair on
      // this screen is the tab whose call is actually running.
      releaseBroadcastRef.current(activeTab);
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
      localStreamRef.current?.getTracks().forEach(track => track.stop());
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      if (camCountRef.current) camCountRef.current.srcObject = stream;
      cameraReadyRef.current = true;
      setCameraReady(true); enumerateDevices();
    } catch (err) {
      // Windows lets one app hold a webcam at a time, and says so in the only two names a
      // locked device ever arrives under. "Could not access camera" leaves him guessing; this
      // tells him to go and close the thing that has it, which is on his side of the cable.
      const busy = err instanceof DOMException && (err.name === "NotReadableError" || err.name === "AbortError");
      toast({
        title: t("Camera Error"),
        description: busy
          ? t("Your camera is being used by another app on this computer, so the app could not open it. Close the other app - another call, a phone link or a camera preview - and turn the camera on again here.")
          : t("Could not access camera."),
        variant: "destructive", withContact: true,
      });
    }
  }, [selectedCamId, enumerateDevices, toast]);

  // Refs so enumerateDevices can restart the live camera without a dep cycle.
  startCameraRef.current = startCamera;

  // ─── Turn camera OFF (release hardware, clear preview) ───────────────────────
  const stopCamera = useCallback(() => {
    localStreamRef.current?.getTracks().forEach(track => track.stop());
    localStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (camCountRef.current) camCountRef.current.srcObject = null;
    cameraReadyRef.current = false;
    setCameraReady(false);
  }, []);

  const handleCameraSwitch = useCallback(async (id: string) => {
    if (id === camSelRef.current) return;
    chooseCam(id);
    if (cameraReady) {
      // Release the previously-selected camera immediately, then start the new one.
      localStreamRef.current?.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      await startCamera(id);
    }
  }, [cameraReady, chooseCam, startCamera]);

  // Strict tab isolation: release the camera whenever the active tab changes, so
  // a camera turned on in one tab never keeps showing in another. Each tab starts
  // with its preview off until the user enables it there.
  useEffect(() => { stopCamera(); }, [activeTab, stopCamera]);

  // ─── Frame-rate readout ────────────────────────────────────────────────────
  // Counts the frames each element actually presented, once a second. The camera
  // figure is what her webcam delivers; the AI figure is what comes back. A call
  // that looks like a slideshow shows up here as a low AI number while the camera
  // keeps counting, which is the one thing a screenshot of the picture cannot
  // prove.
  //
  // Written straight into the spans instead of through state. `DeviceChip`
  // is declared inside this component, so every re-render replaces its identity,
  // React tears the block down and builds a new one, and an open camera drop-down
  // closes under the cursor - which is exactly what a one-second state tick did to
  // it in 1.6.6. Rendered below the panel, never on it.
  useEffect(() => {
    const presented = (el: HTMLVideoElement | null): number | null => {
      if (!el || !el.srcObject) return null;
      const q = el.getVideoPlaybackQuality?.();
      return q ? q.totalVideoFrames : null;
    };
    let prevCam = presented(camCountRef.current);
    let prevAi  = presented(remoteVideoRef.current);
    const iv = setInterval(() => {
      const cam = presented(camCountRef.current);
      const ai  = presented(remoteVideoRef.current);
      const camN = cam !== null && prevCam !== null ? cam - prevCam : null;
      const aiN  = ai  !== null && prevAi  !== null ? ai  - prevAi  : null;
      // Read by the give-up on a blank call: a counter that produced a number during this call
      // is a camera this app was really watching, and a camera that produced no frame at all is
      // the one blank whose cause is on the customer's side of the cable.
      if (camN !== null) camCounterRanRef.current = true;
      if (camN !== null && camN >= 1) camFedFrameRef.current = true;
      if (fpsCamRef.current) fpsCamRef.current.textContent = camN === null ? t("Camera —") : t("Camera {n} fps", { n: camN });
      if (fpsAiRef.current)  fpsAiRef.current.textContent  = aiN === null ? t("AI picture —") : t("AI picture {n} fps", { n: aiN });
      if (fpsHintRef.current) {
        fpsHintRef.current.style.display =
          camN !== null && aiN !== null && camN >= 5 && aiN <= Math.floor(camN / 2) ? "inline" : "none";
      }
      prevCam = cam; prevAi = ai;
    }, 1000);
    return () => clearInterval(iv);
  }, [cameraReady, isStreaming]);

  // ─── Virtual camera: pump AI output frames to the native feeder ─────────────
  // Draws the AI output video into a fixed 1280x720 RGBA8 canvas and pushes each
  // frame over IPC to the Electron main process, which writes it into the
  // "Stream Live Camera" shared-memory buffer. resizemode=LINEAR in the header
  // makes the filter scale to whatever resolution the calling app negotiated.
  //
  // The frame shape never changes between orientations, so flipping the toggle
  // mid-call needs no renegotiation: the next frame simply carries the other
  // composition. drawOutputFrame reads the mode once per frame, so a switch can
  // never land half-way through a composite.
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
      drawOutputFrame(ctx, remoteVideoRef.current, VCAM_W, VCAM_H, portraitRef.current);
      const frame = ctx.getImageData(0, 0, VCAM_W, VCAM_H);
      api?.vcamFrame?.(frame.data.buffer as ArrayBuffer, VCAM_W, VCAM_H);
    }
    vcamTimerRef.current = setTimeout(vcamTick, 33); // ~30fps
  }, []);

  const stopVCamPump = useCallback(() => {
    vcamOnRef.current = false;
    if (vcamTimerRef.current) { clearTimeout(vcamTimerRef.current); vcamTimerRef.current = null; }
  }, []);

  // Put the picture out, or take it back in. `auto` is the pass that runs when this page opens:
  // it says nothing in a popup, because the line under the switch already carries the truth.
  const runVCam = useCallback(async (on: boolean, auto: boolean, tab: TabId): Promise<void> => {
    const api = getElectronAPI();
    if (!api?.vcamStart || !api?.vcamStop) {
      setVcamSupported(false);
      if (!auto) toast({ title: t("Virtual camera unavailable"), description: t("Run in the Stream Live desktop app on Windows, and install the Stream Live Camera driver."), variant: "destructive", withContact: true });
      return;
    }
    if (on) {
      const r = await api.vcamStart();
      setVcamSupported(r.supported);
      if (!r.supported) {
        if (!auto) toast({ title: t("Virtual camera unavailable"), description: r.error || t("The native driver layer could not load."), variant: "destructive", withContact: true });
        setCamFor(tab, false);
        return;
      }
      setCamFor(tab, true);
      vcamOnRef.current = true;
      vcamTick();
      if (!auto) toast({ title: t("Stream Live Camera ON"), description: t("Select “Stream Live Camera” in Zoom/Teams/Chrome. It shows the AI output while streaming.") });
    } else {
      stopVCamPump();
      await api.vcamStop();
      setCamFor(tab, false);
      setVcamReady(false);
    }
  }, [vcamTick, stopVCamPump, toast, setCamFor]);

  const toggleVCam = useCallback(async () => {
    await runVCam(!vcamEnabled, false, activeTab);
  }, [vcamEnabled, activeTab, runVCam]);

  // Poll native readiness (true once a calling app has opened the camera). A tab with no call of its
  // own has no camera to be ready, so its line must not keep the last tab's word.
  useEffect(() => {
    if (!vcamEnabled) { setVcamReady(false); return; }
    let alive = true;
    const iv = setInterval(async () => {
      const st = await getElectronAPI()?.vcamStatus?.();
      if (alive && st) { setVcamReady(st.ready); setVcamSupported(st.supported); }
    }, 1000);
    return () => { alive = false; clearInterval(iv); };
  }, [vcamEnabled]);

  // Always tear the feeder down on unmount.
  useEffect(() => () => { stopVCamPump(); getElectronAPI()?.vcamStop?.(); }, [stopVCamPump]);

  // ─── Virtual microphone: route your own voice to the VB-Cable sink ──────────
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
        s.getTracks().forEach(track => track.stop());
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
      // Windows hides the cable output's label, so a machine with exactly one
      // unnamed output has only one candidate. Anything less certain is left to the
      // "Audio out" dropdown: guessing by playing probe tones meant opening the live
      // call's own microphone and beeping into the customer's speakers mid-call.
      if (!hit) {
        const cands = outsOf(devs).filter(d => !d.label);
        if (cands.length === 1) hit = cands[0];
      }
      return hit ? { id: hit.deviceId, label: hit.label || t("{cable} (auto-detected)", { cable: CABLE_NAME }) } : null;
    } catch { return null; }
  }, [ensureMediaPermission]);

  const applyAudioRoute = useCallback(async (on: boolean, auto: boolean, tab: TabId) => {
    type SinkEl = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
    // The cable carries sound the app holds itself: the microphone, or the cloned
    // voice. Never whatever the video engine returns — the model is video-to-video
    // and may hand back no audio at all, which left callers hearing total silence.
    const micEl = micRouteRef.current;
    if (micEl) {
      if (on) {
        if (micRouteStreamRef.current && micEl.srcObject !== micRouteStreamRef.current) {
          micEl.srcObject = micRouteStreamRef.current;
        }
        void micEl.play().catch(() => { /* no stream to play yet */ });
      } else {
        try { micEl.pause(); } catch { /* ignore */ }
        micEl.srcObject = null;
      }
    }
    const els = [micEl, cloneAudioRef.current].filter(Boolean) as SinkEl[];
    if (!els.length) return;
    const setSinks = async (id: string) => { for (const el of els) await el.setSinkId!(id); };
    if (!on) { for (const el of els) { try { await el.setSinkId?.(""); } catch { /* ignore */ } } setCableSinkLabel(""); setBroadcastBlocked(""); return; }
    if (els.some(el => typeof el.setSinkId !== "function")) {
      if (!auto) toast({ title: t("Audio routing unsupported"), description: t("This runtime can't select an output device."), variant: "destructive", withContact: true });
      setMicFor(tab, false); setBroadcastBlocked("no-sink"); return;
    }
    // 1) User-pinned output device (works even when labels are hidden).
    if (manualSinkId) {
      try {
        await setSinks(manualSinkId);
        const lbl = audioOutputs.find(d => d.deviceId === manualSinkId)?.label;
        setCableSinkLabel(lbl || t("Pinned output"));
        setBroadcastBlocked("");
        return;
      } catch { /* pinned device gone; fall through to auto-detect */ }
    }
    const cable = await findCableSink();
    if (cable) {
      try {
        await setSinks(cable.id);
        setCableSinkLabel(cable.label);
        setBroadcastBlocked("");
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
        ? t(" Outputs seen: {list}.", { list: outs.map(d => d.label || "(hidden)").join(", ") })
        : t(" No audio output devices enumerated at all.");
    } catch { diag = t(" Could not enumerate devices."); }
    if (!auto) toast({
      title: t("Virtual microphone not detected"),
      description: IS_MAC
        ? t("{cable} isn't visible to Stream Live.{diag} Install it from existential.audio/blackhole, log out and back in, then pick it in the “Audio out” dropdown. Steps: Settings → Mac Setup.", { cable: CABLE_NAME, diag })
        : t("The VB-Audio cable output device isn't visible.{diag} Pick it manually from the “Audio out” dropdown in the Broadcast panel (choose the unlabeled / VB-Cable entry), or set “Speakers (VB-Audio Virtual Cable)” as your Windows default playback device.", { diag }),
      variant: "destructive", withContact: true,
    });
    setMicFor(tab, false); setBroadcastBlocked("no-cable"); return;
  }, [findCableSink, toast, manualSinkId, audioOutputs, chooseManualSink, setMicFor]);

  const toggleAudioRoute = useCallback(async () => {
    const next = !audioRouteOn;
    setMicFor(activeTab, next);
    if (!next) setBroadcastBlocked("");
    await applyAudioRoute(next, false, activeTab);
    if (next && voiceMonitor && clonerRef.current) {
      toast({ title: t("Local monitor is on"), description: t("Your cloned voice also plays in your speakers. Use headphones — loudspeakers let your mic feed it back into the call.") });
    }
  }, [audioRouteOn, activeTab, applyAudioRoute, setMicFor, voiceMonitor, toast]);

  // Put both of this tab's fake devices back. Called when the tab's own call ends and when he
  // walks off a tab that holds no call, so a lit switch always means "this tab is using it".
  const releaseBroadcast = useCallback((tab: TabId): void => {
    stopVCamPump();
    void getElectronAPI()?.vcamStop?.();
    setVcamReady(false);
    setCamFor(tab, false);
    setMicFor(tab, false);
    void applyAudioRoute(false, true, tab);
  }, [stopVCamPump, applyAudioRoute, setCamFor, setMicFor]);

  useEffect(() => { releaseBroadcastRef.current = releaseBroadcast; }, [releaseBroadcast]);

  // Re-apply routing when the AI output (re)connects, since srcObject changes,
  // and when the cloned voice stream starts (its audio element mounts then).
  useEffect(() => {
    if (audioRouteOn && connStatus === "connected") void applyAudioRoute(true, true, activeTab);
  }, [connStatus, audioRouteOn, activeTab, applyAudioRoute, vcActive]);

  // The AI element is a picture source and nothing more. The engine is video-to-video,
  // so any audio that ever comes back on it is at best a delayed copy of the microphone
  // we already send to the cable — muted always, so the voice can never be doubled or
  // howl back into the open mic.
  useEffect(() => {
    const v = remoteVideoRef.current;
    if (v) v.muted = true;
  }, [connStatus]);

  // With cloning on, the cable carries the persona voice — and nothing else. A clone that
  // used to go quiet here simply put his raw microphone back on the cable, which let the
  // call run on for minutes with a voice nobody bought. That trade is closed: a word he
  // speaks that the service never answers ends the call instead, and everything the call had
  // set aside but not used comes back. A pause in the conversation is not a fault, so it
  // moves nothing — only an unanswered send does.
  const [cloneAlive, setCloneAlive] = useState(false);
  // What the voice service has been handed and what it has sent back, read off the engine
  // once a second beside the liveness check. The meters on that card come from the audio
  // graph; these come from the counting, so a bar that moved on a piece which never left
  // this app can never be read as an answer.
  const [voiceRead, setVoiceRead] = useState({ sent: 0, back: 0, inS: 0, outS: 0, lastMs: 0 });
  useEffect(() => {
    if (!vcActive) { setCloneAlive(false); setVoiceRead({ sent: 0, back: 0, inS: 0, outS: 0, lastMs: 0 }); return; }
    const read = () => {
      const c = clonerRef.current;
      setCloneAlive(!!c && c.alive(CLONE_ALIVE_SECONDS));
      setVoiceRead({ sent: c?.piecesSent ?? 0, back: c?.piecesBack ?? 0,
        inS: c?.secondsIn ?? 0, outS: c?.secondsOut ?? 0, lastMs: c?.lastAnswerMs ?? 0 });
    };
    read();
    const watch = setInterval(read, 1000);
    return () => clearInterval(watch);
  }, [vcActive]);

  useEffect(() => {
    const el = micRouteRef.current;
    if (!el) return;
    if (vcActive) { try { el.pause(); } catch { /* ignore */ } }
    else if (audioRouteOn) {
      if (micRouteStreamRef.current && el.srcObject !== micRouteStreamRef.current) {
        el.srcObject = micRouteStreamRef.current;
      }
      void el.play().catch(() => { /* nothing attached yet */ });
    }
  }, [vcActive, audioRouteOn, connStatus]);

  // With routing OFF the clone already reaches your speakers through the audio
  // element; monitor mode only adds local playback when the clone is on the cable.
  useEffect(() => {
    clonerRef.current?.setMonitor(voiceMonitor && audioRouteOn);
  }, [voiceMonitor, audioRouteOn, vcActive]);

  // ─── Microphone check: proof that costs no minutes ─────────────────────────
  // Opens the selected microphone for a few seconds, runs the same learning the app runs inside
  // a call, and paints it on the card. Bounded on purpose — the microphone is handed back when
  // it is finished instead of being left open on the page.
  const micCheckRef = useRef<{ stop: () => void } | null>(null);
  const runMicCheck = useCallback(() => {
    micCheckRef.current?.stop();
    setMicChecking(true);
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let finished = false;
    const gate = new VoiceGate();
    const stop = () => {
      finished = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach(track => track.stop());
      ctx?.close().catch(() => {});
      if (micCheckRef.current?.stop === stop) { micCheckRef.current = null; setMicChecking(false); }
    };
    micCheckRef.current = { stop };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: micAudioConstraints(selectedMicId || undefined), video: false,
        });
        if (finished) { stream.getTracks().forEach(track => track.stop()); return; }
        ctx = new AudioContext();
        if (ctx.state !== "running") { try { await ctx.resume(); } catch { /* ignore */ } }
        const src = ctx.createMediaStreamSource(stream);
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass"; hp.frequency.value = 90; hp.Q.value = 0.7;
        const an = ctx.createAnalyser(); an.fftSize = 512;
        an.minDecibels = -90; an.maxDecibels = -10;
        src.connect(hp); hp.connect(an);
        const data = new Uint8Array(an.frequencyBinCount);
        const rate = ctx.sampleRate;
        timer = setInterval(() => {
          an.getByteFrequencyData(data);
          const level = voiceBandLevel(data, rate);
          gate.update(level, WINDOW_MS / 1000);
          paintMic(gate.vu(level), gateState(gate));
        }, WINDOW_MS);
        setTimeout(stop, MIC_CHECK_SECONDS * 1000);
      } catch {
        paintMic(0, "silent");
        if (micCheckRef.current?.stop === stop) { micCheckRef.current = null; setMicChecking(false); }
      }
    })();
  }, [selectedMicId, paintMic]);

  useEffect(() => () => micCheckRef.current?.stop(), []);

  // ─── The money clock on a cloning call ───────────────────────────────────────
  // A video call is metered from its first frame. A cloning call waits one step longer: the
  // first frame only means the picture arrived, and the thing the customer paid for on this
  // tab is the voice. The clock is held until the cloned voice actually answers, and a call
  // that is still waiting after a bounded pause is metered like any other video call — a man
  // who has simply not spoken yet is on air, and owes for it.
  const releaseAirHold = useCallback(() => {
    if (airHoldRef.current) { clearTimeout(airHoldRef.current); airHoldRef.current = null; }
  }, []);

  const markAirWhenReady = useCallback(() => {
    if (!cloneThisCallRef.current) { markMedia(); return; }
    const cloner = clonerRef.current;
    if (cloner && cloner.answeredAt > 0) { releaseAirHold(); markMedia(); return; }
    if (airHoldRef.current) return;
    // Never let the hold run past the gateway's own picture-less deadline, or the server
    // closes a call that was working and the customer reads that as a fault.
    const lived = account.live ? Date.now() - account.live.startedAt : 0;
    const hold = Math.min(CLONE_FIRST_AIR_MS, Math.max(0, CLONE_AIR_HARD_MS - lived));
    if (hold <= 0) { markMedia(); return; }
    airHoldRef.current = setTimeout(() => { airHoldRef.current = null; markMedia(); }, hold);
  }, [account.live, releaseAirHold]);

  // ─── The wait this machine owes before its next call ─────────────────────────
  /**
   * Hold Start for `ms` and count the seconds on the button.
   *
   * A call that showed no picture has already cost the seller its dial, and the customer got
   * nothing for it, so the two things that matter here are that he is told a wait that is
   * true and that nothing re-dials during it. When the server announced the number, that is the
   * wait - it measured this machine. When the app gave up by itself it holds the ordinary
   * window, because a man kept out for four minutes whose line freed at two has lost time he
   * will not get back; if he is on the long window his first press is refused and the refusal
   * carries the seconds truly left, which the button then counts.
   *
   * `why` is the sentence that goes with that particular wait. The button cannot explain
   * itself, and something does have to be said when the OBS cable asks for a call of its own
   * while the count is still running.
   */
  const armHold = useCallback((ms: number, why: string) => {
    const until = Date.now() + ms;
    if (holdUntilRef.current === null || until > holdUntilRef.current) {
      holdUntilRef.current = until;
      holdMsgRef.current = why;
    }
    if (holdTimerRef.current) clearInterval(holdTimerRef.current);
    const tick = () => {
      const left = (holdUntilRef.current ?? 0) - Date.now();
      if (left <= 0) {
        if (holdTimerRef.current) clearInterval(holdTimerRef.current);
        holdTimerRef.current = null;
        holdUntilRef.current = null;
        setHoldSeconds(null);
        return;
      }
      setHoldSeconds(Math.ceil(left / 1000));
    };
    setHoldSeconds(Math.ceil(((holdUntilRef.current ?? until) - Date.now()) / 1000));
    holdTimerRef.current = setInterval(tick, 1000);
  }, []);

  useEffect(() => () => { if (holdTimerRef.current) clearInterval(holdTimerRef.current); }, []);

  // ─── Teardown ──────────────────────────────────────────────────────────────
  const teardownStream = useCallback(async () => {
    sessionGenRef.current++;
    if (iceGraceRef.current) { clearTimeout(iceGraceRef.current); iceGraceRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    isStartingRef.current = false;
    closingRef.current = true; setIsClosing(true);
    try {
      // Say who closed this call before anything else moves, because every path below can
      // throw and the answer is worth nothing if it is lost with the rest of the teardown.
      // Taken from the ref, not read later: the id is cleared a few lines down.
      reportCallEnd(sessionIdRef.current, stoppedByHandRef.current ? "user" : "app");
      stoppedByHandRef.current = false;
      endLease();
      releaseAirHold();
      cloneThisCallRef.current = false;
      firstFrameRef.current = null;
      videoSessionRef.current?.close(); videoSessionRef.current = null;
      clonerRef.current?.stop(); clonerRef.current = null;
      if (cloneAudioRef.current) { try { cloneAudioRef.current.pause(); } catch { /**/ } cloneAudioRef.current.srcObject = null; }
      // The cable loses the microphone the moment the call is over, so a second call
      // never starts with two voices on it.
      if (micRouteRef.current) { try { micRouteRef.current.pause(); } catch { /**/ } micRouteRef.current.srcObject = null; }
      micRouteStreamRef.current = null;
      // The call is over, so the two switches that call lit go back off — on the tab that dialled,
      // which is the tab he was standing on when it opened.
      releaseBroadcastRef.current(broadcastOwnerRef.current);
      syncPipeRef.current?.stop(); syncPipeRef.current = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      remoteStreamRef.current = null; window.__slRemoteStream = null;
      [popoutRef, obsWindowRef, obsPortraitWindowRef].forEach(r => {
        if (r.current && !r.current.closed) try { r.current.postMessage("stream-live-clear", "*"); } catch { /**/ }
      });
      setIsStreaming(false); streamingRef.current = false;
      setConnStatus("idle"); setConnStep(null); setElapsed(0);
      setAudioActive(false); setSyncDelay(FALLBACK_HOLD); setSyncMeasured(false); setSyncLive(false); setSyncReason("waiting");
      paintMic(0, "silent");
      paintCable(0);
      setVcActive(false); setVcVu(0); setVcAnalyser(null);
      // Refund the prepaid chunk only after the call is locally dead. Waiting for
      // that round-trip first left Stop unresponsive — and an unreached one is
      // handed back by the gateway on the next Start from this machine.
      sessionIdRef.current = null;
      await Promise.race([
        gateway.endCall().catch(() => {}),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    } finally {
      // Nothing below this point may be skipped. A throw from the engine's close left
      // the page believing it was still closing, which dead-ends Start with no message.
      closingRef.current = false; setIsClosing(false);
      void refreshBalances();
    }
  }, [releaseAirHold]);

  // Route changes (e.g. opening Settings mid-stream) unmount this page. Without
  // this the fal WebSocket would stay open and keep billing in the background.
  useEffect(() => { return () => { startCancelRef.current = true; void teardownStream(); }; }, [teardownStream]);

  // The call itself goes with the voice: the picture stops, the cable goes quiet, and the
  // customer is told what closed it while he is still looking at the page.
  useEffect(() => {
    if (!isStreaming || !vcActive || closingRef.current) return;
    // The engine is asked live, not from the flag above: on the render that switches the
    // clone on, the watcher has not reported yet, and its first answer is always "silent".
    const cloner = clonerRef.current;
    if (!cloner || cloner.alive(CLONE_ALIVE_SECONDS)) return;
    void teardownStream();
    toast({
      title: t("Call ended"), description: endReasonMessage("clone_stopped"),
      variant: "destructive", withContact: true,
    });
  }, [isStreaming, vcActive, cloneAlive, teardownStream, toast]);

  // ─── Stop the call when the countdown reaches zero ─────────────────────────
  // The gateway only re-prices the lease on the 45-second heartbeat, so left to
  // itself a call stays on air for up to that long after the bucket is empty: the
  // clock reads 0:00 and nothing happens until the user presses Stop. The meter
  // tells him the call stops now, so arm a timer for the second its own minutes
  // run out. A call that has not shown a frame spends nothing, so its deadline is
  // measured from the frame; and a call opened on the last sliver of change gets
  // its first few seconds rather than a drop that looks like a crash.
  //
  // The gateway now names that second itself: each renewal answers with the seconds the
  // window it just bought pays for, and a renewal only ever buys what the wallet still
  // holds. So this is the server's own bound, and the countdown is used only while the
  // server has not given one - before the first renewal, on an unlimited bucket, or on a
  // video call still waiting for its picture. When a heartbeat is lost the bound stops
  // moving and the call ends at the second the paid-for airtime does, instead of streaming
  // on unbilled until the engine gives up.
  useEffect(() => {
    const MIN_FUNDED_MS = 10_000;
    const lease = account.live;
    if (!isStreaming || !lease || lease.unlimited) return;
    const burn = bucketFor(account, lease.modality)?.burnRate ?? 1;
    const stopAt = stopDeadlineAt(lease, burn, Date.now(), MIN_FUNDED_MS);
    const id = setTimeout(() => {
      if (!sessionIdRef.current) return;
      void teardownStream();
      toast({ title: t("Out of minutes"), description: endReasonMessage("out_of_minutes"), variant: "destructive" });
      setLocation("/minutes");
    }, Math.max(0, stopAt - Date.now()));
    return () => clearTimeout(id);
  }, [isStreaming, account, teardownStream, toast, setLocation]);

  /**
   * What this machine saw while the screen stayed blank, turned into the two things that need
   * it: the sentence for the customer, and the line for his administrator's log.
   *
   * Taken before a teardown, never after one. The signals belong to the call being given up on,
   * and they are cleared when the next call opens rather than when this one closes, so the
   * answer cannot be contaminated by whatever the camera was doing beforehand.
   *
   * `lineAnswer` is what the video service itself said, and only the caller holding a thrown
   * engine error has it. A call that was taken and then went blank leaves it empty, because
   * there was no answer to quote.
   */
  const blindReadout = useCallback((lineAnswer = "") => {
    const evidence: NoPictureEvidence = {
      cameraSeen: camCounterRanRef.current,
      cameraProducing: camFedFrameRef.current,
      connected: lineConnectedRef.current,
      lineAnswer,
    };
    const cause = noPictureCause(evidence);
    const off = clockSkewMs();
    const note = off === null || Math.abs(off) < CLOCK_NOTICE_MS
      ? "" : ` [machine clock ${describeClockSkew(off)} real time]`;
    return { cause, detail: noPictureDetail(evidence, cause, note), message: endReasonMessage(cause) };
  }, []);

  // ─── Give up on a call that never puts a picture on screen ──────────────────
  // The gateway bills nothing before the first frame, so every second of a blank call is the
  // seller's cost and the customer's dead time. Left alone it sits there looking broken until
  // he presses Stop himself - which is exactly what the three blank calls of 2026-11-01 were,
  // at 90, 90 and 60 seconds of engine. Closing it here puts the picture down a few seconds
  // before the gateway's own 45-second check-in would, and says what happened while he is
  // still looking at the black box rather than an hour later in a support message.
  useEffect(() => {
    const lease = account.live;
    const sid = sessionIdRef.current;
    if (!isStreaming || !lease || !sid || lease.modality === "audio") return;
    if (firstFrameRef.current !== null) return;
    const id = setTimeout(() => {
      // A frame that arrived in the meantime, or a call that is no longer the one being
      // watched, both mean there is nothing to give up on.
      if (firstFrameRef.current !== null || sessionIdRef.current !== sid) return;
      const blind = blindReadout();
      reportCallFailure(sid, "engine",
        `no picture ${Math.round(PICTURE_GIVE_UP_MS / 1000)} s after the call opened; this app ended it — ${blind.detail}`);
      void teardownStream();
      armHold(BLIND_RETRY_HOLD_MS, blind.message);
      toast({ title: t("Call ended"), description: blind.message, variant: "destructive" });
    }, Math.max(0, lease.startedAt + PICTURE_GIVE_UP_MS - Date.now()));
    return () => clearTimeout(id);
  }, [isStreaming, account, teardownStream, armHold, toast, blindReadout]);

  // ─── Give up on a voice call whose voice never arrives ────────────────────────
  // A voice-only call has no picture to watch, and its meter now holds at zero until cloned
  // audio actually reaches this machine. So a call the voice service never answers costs the
  // customer nothing and leaves the seller's voice line open: this closes it, on the same
  // 40 seconds the picture call gives itself, rather than leaving him sitting on a silent page
  // until the gateway's own check-in cuts the lease.
  useEffect(() => {
    const lease = account.live;
    const sid = sessionIdRef.current;
    if (!isStreaming || !lease || !sid || lease.modality !== "audio") return;
    if (lease.mediaAt !== null) return;
    const id = setTimeout(() => {
      // Cloned audio that arrived in the meantime, or a call that is no longer the one being
      // watched, both mean there is nothing to give up on.
      if (sessionIdRef.current !== sid || account.live?.mediaAt !== null) return;
      reportCallFailure(sid, "engine",
        `no cloned audio ${Math.round(PICTURE_GIVE_UP_MS / 1000)} s after the call opened; this app ended it`);
      void teardownStream();
      toast({ title: t("Call ended"), description: endReasonMessage("no_voice"), variant: "destructive", withContact: true });
    }, Math.max(0, lease.startedAt + PICTURE_GIVE_UP_MS - Date.now()));
    return () => clearTimeout(id);
  }, [isStreaming, account, teardownStream, toast]);

  // ─── Start stream ──────────────────────────────────────────────────────────
  /**
   * One ask for a call: open the metered lease, then the pipelines.
   *
   * The tab he is standing on is the call he wants, and it is the only thing that decides it:
   * `audio-only` asks for the cloning call with no picture in it. The gateway meters that one as
   * an audio session and hands back no video key, so this branch opens the microphone, the cable
   * and the clone and stops there — no WebRTC, no frame, nothing for a stage to show.
   *
   * Returns null when the call is on air, and a StartFailure when anything refused it.
   * Nothing in here speaks to the customer — the caller decides whether to ask the
   * engine again first, so the sentence he ends up reading matches the number of tries
   * already spent on his behalf.
   */
  const attemptStart = useCallback(async (tabName: TabName, needsVoice: boolean): Promise<StartFailure | null> => {
    const voiceOnly = tabName === "audio-only";
    // The gateway owns this from the moment startCall answers, and teardownStream()
    // clears the page's copy of it before the failure reaches the caller — so it is
    // held here too, for the record of what the video service answered.
    let sessionId: string | null = null;
    let engine: string | null = null;
    // The microphone is proven before anything is booked on a cloning call, and the very
    // stream that proved it is the one the call then runs on.
    let mic: MediaStream | null = null;
    let micHandedOff = false;
    // On a cloning call the two questions asked first are the ones with no answer in the
    // minutes: is his voice reaching the app, and will the voice service answer at all.
    if (needsVoice) setConnStep("mic"); else setConnStep("auth");
    setConnStatus("connecting");
    try {
      if (needsVoice) {
        try { mic = await openMicrophone(selectedMicId || undefined); }
        catch { return preflightFailure("mic_not_ready"); }
        // Nothing is metered here: this only asks the voice service to list his saved voices.
        // A service that will not answer at all is known before the lease opens rather than
        // discovered as a silent call after it.
        const door = await voiceDoorReason();
        if (door !== null) return preflightFailure(door === "modality_disabled" ? "clone_closed" : door);
      }
      setConnStep("auth");
      // Open the metered lease first: nothing touches WebRTC until the gateway
      // confirms this account and bucket can pay for the call.
      const ticket = await gateway.startCall(tabName, await deviceId(), needsVoice ? vcVoiceId : undefined);
      sessionId = ticket.sessionId;
      engine = ticket.engine ?? null;
      sessionIdRef.current = ticket.sessionId;
      // The pass the gateway just handed out is checked against the clock on this machine, so
      // a computer running hours ahead reads a minutes-old pass as already spent and never
      // asks for the call at all. From here the app keeps the gateway's time — and it must
      // take it before the lease is booked, because that booking stamps the machine's own
      // reading once and every timer then reads it against the corrected one.
      const skew = alignClock(ticket.serverTimeMs);
      if (skew !== null) noteClockSkew(skew);

      beginLease(ticket);
      // From this second the lease is live, so the page remembers what kind of call it is:
      // a cloning call is not on air until the cloned voice has answered.
      cloneThisCallRef.current = needsVoice;
      // A new call, so a clean set of signals: anything the counters say from here belongs to
      // the call that may have to be given up on.
      camCounterRanRef.current = false;
      camFedFrameRef.current   = false;
      lineConnectedRef.current = false;
      paintedRef.current       = false;
      stoppedByHandRef.current = false;

      setConnStep(voiceOnly ? "voice" : "engine");
      const style  = STYLES.find(s => s.id === selectedStyle)!;
      const prompt = customPrompt.trim() || style.prompt;

      // ── Audio sync pipeline (video tabs only) ──────────────────────────
      let sendStream = localStreamRef.current ?? new MediaStream();
      let micStreamForCloner: MediaStream | null = null;

      const pipe = new AudioSyncPipeline();
      pipe.onUpdate = (delay, vu, measured, live, state, cable, reason) => {
        setSyncDelay(delay); setSyncMeasured(measured); setSyncLive(live); setSyncReason(reason);
        paintMic(vu, state);
        paintCable(cable);
        // A voice-only call holds nothing back: there is no mouth on a picture to line the
        // cloned voice up with, so the hold the estimator would learn here has no use.
        if (!voiceOnly) clonerRef.current?.setVideoDelay(delay);
      };
      // The AI picture is sampled from the stage's own element rather than from the
      // picture-in-picture box, which portrait hides - a timing rule that only works in one
      // orientation is a rule that reports "not measured" to half the customers. A Voice Only
      // call hands in nothing at all, and the estimator then simply never has a mouth to watch.
      const streams = await pipe.start(remoteVideoRef.current, selectedMicId || undefined, mic);
      micHandedOff = true;
      syncPipeRef.current = pipe;
      if (streams) {
        // The AI hears you the instant you speak. Holding it back can never line the
        // avatar's mouth up with its own picture, because the engine renders the
        // mouth some fraction of a second *after* it receives the word.
        const engineTrack = streams.engine.getAudioTracks()[0];
        if (engineTrack) { sendStream = new MediaStream([...(localStreamRef.current?.getVideoTracks() ?? []), engineTrack]); setAudioActive(true); }
        // Only the virtual microphone is delayed, so callers hear your word at the
        // moment the avatar's mouth makes it on the picture they are watching.
        micRouteStreamRef.current = streams.cable;
      }
      micStreamForCloner = pipe.getMicStream();

      // ── Start video session ────────────────────────────────────────────
      // Both remaining tabs put a picture on the line, so a token always comes back.
      // Which of the two pipelines opens is the gateway's call, made from the account's
      // wallet; this page only obeys it, and never says it out loud.
      //
      // A voice-only call is not one of them. The gateway meters it as an audio session and
      // hands back no video key, and the man who pressed that button asked for his voice on
      // the line with nothing to look at, so this page opens no WebRTC call for it.
      if (!voiceOnly) {
        if (!ticket.token) throw new Error(`${APP}: gateway returned no video token`);
        const gen = ++sessionGenRef.current;
        const lineOpenedAt = Date.now();
        // The line's own close, written while the call is still on the page. Without this a
        // call that ended on its own leaves a row saying it started and a row saying it ended,
        // and nothing at all saying what closed it — which is why "it stopped by itself" could
        // only ever be reconstructed after the fact from the lease windows.
        const reportLineClose = (why: string) => {
          if (sessionGenRef.current !== gen) return;
          const held = Math.max(0, Math.round((Date.now() - lineOpenedAt) / 1000));
          reportCallFailure(sessionId, "video line closed", `${held} s into the call — ${why}`);
        };
        const open = ticket.engine === "decart" ? _startTrialVideoSession : _startVideoSession;
        const session = await open(
          ticket.token, sendStream,
          remote => {
            if (sessionGenRef.current !== gen) return;
            // A stream reached this computer: the line is connected as far as the blank screen
            // is concerned, whatever the transport's own state machine goes on reporting.
            lineConnectedRef.current = true;
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
              lineConnectedRef.current = true;
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
              reportLineClose("the transport went away and did not come back within 6 s");
              void teardownStream();
              toast({ title: t("Call ended"), description: endReasonMessage("connection_lost"), variant: "destructive", withContact: true });
            }, 6000);
          },
          why => {
            if (sessionGenRef.current !== gen) return;
            reportLineClose(`the video service closed the line (${why})`);
            void teardownStream();
            toast({ title: t("Call ended"), description: endReasonMessage("connection_lost"), variant: "destructive", withContact: true });
          },
          prompt, refImageB64,
        );
        if (sessionGenRef.current !== gen) { session.close(); return null; }
        videoSessionRef.current = session;
      }

      // ── Start voice cloning ────────────────────────────────────────────
      // The tab he chose buys a cloned voice, not his own. If the microphone never reached
      // the pipeline, the call would run silent-to-clone for its whole length; that is the
      // one outcome worse than a refused start, so the lease is handed straight back.
      if (needsVoice && !micStreamForCloner) {
        void teardownStream();
        return preflightFailure("mic_not_ready");
      }
      if (needsVoice && micStreamForCloner) {
        const cloner = new VoiceCloningEngine();
        cloner.call    = (path, body) => gateway.voice(path, body, { isStream: true, sessionId: ticket.sessionId });
        cloner.voiceId = vcVoiceId;
        cloner.setVideoDelay(voiceOnly ? 0 : (syncPipeRef.current?.hold ?? FALLBACK_HOLD));
        cloner.onVu    = v => setVcVu(v);
        // The first answer from the cloned voice is the moment this call is really on air.
        cloner.onFirstAnswer = () => { releaseAirHold(); markMedia(); };
        cloner.playerLive = () => {
          const el = cloneAudioRef.current;
          return !!el && !el.paused && el.readyState >= 2;
        };
        cloner.onError = msg => toast({ title: t("Voice engine problem"), description: toUserMessage(msg, t("The voice service had trouble. Try again.")), variant: "destructive", withContact: true });
        await cloner.start(micStreamForCloner);
        clonerRef.current = cloner;
        setVcAnalyser(cloner.getAnalyser());
        setVcActive(true);
        const out = cloner.getOutputStream();
        if (out && cloneAudioRef.current) {
          cloneAudioRef.current.srcObject = out;
          void cloneAudioRef.current.play().catch(() => {});
        }
      }

      // The Voice Only call is open the moment its pipelines are running: there is no WebRTC
      // hand to wait for, and the cable re-attach that a picture used to signal is owed here
      // instead — the cloned voice has to reach the software microphone with nothing on screen.
      if (voiceOnly) {
        setConnStep(null);
        setConnStatus("connected");
      }

      // Heartbeat well inside the 120 s lease TTL. When it reports ended the
      // bucket has run dry: stop cleanly and tell the user to ask for a top-up.
      gateway.beginHeartbeat(state => {
        updateLease(ticket.sessionId, state);
        void refreshBalances();
        if (state.ended) {
          // Read before the teardown: whichever of the two gets here first, the customer gets
          // the sentence this machine can prove rather than the general one.
          const blind = state.reason === "no_picture" ? blindReadout() : null;
          void teardownStream();
          const oom = state.reason === "out_of_minutes";
          // The gateway cut a blank call at its own deadline. Same hold as the app's give-up,
          // so whichever of the two gets there first leaves him with one number to wait for.
          if (blind) armHold(BLIND_RETRY_HOLD_MS, blind.message);
          toast({ title: oom ? t("Out of minutes") : t("Call ended"),
                  description: blind ? blind.message : endReasonMessage(state.reason),
                  variant: "destructive", withContact: true });
          if (oom) setLocation("/minutes");
        }
      }, 45_000);

      // The call is open: NOW this tab's switches light, and only this tab's. Before this line the
      // machine's one fake camera and one cable belonged to nothing, which is how a build ended up
      // pumping a black picture into Zoom with no call running. Voice Only sends no picture, so it
      // lights the microphone alone - the same reason that tab draws no camera row.
      broadcastOwnerRef.current = activeTab;
      const genAtOpen = sessionGenRef.current;
      if (!voiceOnly && !camOnTab[activeTab]) await runVCam(true, true, activeTab);
      if (!micOnTab[activeTab]) { setMicFor(activeTab, true); await applyAudioRoute(true, true, activeTab); }
      // He cancelled, or the line died, while the devices were being handed over. A switch must not
      // outlive the call that lit it.
      if (startCancelRef.current || sessionGenRef.current !== genAtOpen) releaseBroadcastRef.current(activeTab);

      const t0 = Date.now();
      timerRef.current = setInterval(() => { setElapsed(Math.floor((Date.now() - t0) / 1000)); }, 1000);
      setIsStreaming(true); streamingRef.current = true;
      return null;

    } catch (err) {
      // teardownStream gives back any prepaid chunk, so no separate refund call.
      void teardownStream();
      // The lease was open and no picture arrived. This is the failure that used to end
      // in "Could not start the call. Please try again." with nothing left behind: the
      // engine's own words now go to the gateway's log table, and repeating the ask is
      // what the measurements say actually gets a call through.
      // Recorded beside the engine's own words so the panel can tell a machine whose clock was
      // hours off from a video line that genuinely stopped answering.
      const offMs = clockSkewMs();
      const clockNote = offMs === null || Math.abs(offMs) < CLOCK_NOTICE_MS
        ? "" : ` [machine clock ${describeClockSkew(offMs)} real time]`;
      // A call that died with the screen blank, and never painted a frame at all: this machine
      // knows whether its own camera was feeding the app and whether a connection ever came up,
      // and either of those is worth more to the customer than the blanket sentence. The
      // remainder (picture_hold) keeps the blanket one, because it promises a countdown this
      // path never shows, and the asks themselves are unchanged either way.
      const blank = sessionId !== null && !paintedRef.current;
      // Only an answer from the video service can be a line saying it is full, and that is the
      // one cause that is ours rather than this machine's. A gateway refusal already names
      // itself, so its words are not read as a capacity answer.
      const words = err instanceof Error ? err.message : String(err);
      const blind = blank ? blindReadout(err instanceof GatewayError ? "" : words) : null;
      return classifyStartFailure(
        err instanceof GatewayError ? err.reason : null,
        words + (blind === null ? clockNote : ` — ${blind.detail}`),
        sessionId,
        err instanceof GatewayError ? err.retryAfterSeconds : null,
        engine,
        blind !== null && blind.cause !== "picture_hold" ? blind.cause : null,
      );
    } finally {
      // A microphone proven before the lease and never handed to a pipeline belongs to
      // nothing, and Windows shows a recording light while it is open.
      if (!micHandedOff && mic) mic.getTracks().forEach(t => t.stop());
    }
  }, [selectedStyle, customPrompt, refImageB64, selectedMicId, vcVoiceId, teardownStream, toast, setLocation, releaseAirHold, armHold, blindReadout,
      activeTab, camOnTab, micOnTab, runVCam, applyAudioRoute, setMicFor]);

  /**
   * Sleep, counting the seconds on screen. A wait the server announced for this exact
   * machine is not a mystery pause, so it is shown as one with a number on it - and the
   * Cancel button is honoured in the middle of it rather than at the end.
   */
  const countedWait = useCallback((ms: number) => new Promise<void>(resolve => {
    const until = Date.now() + ms;
    setPacingSeconds(Math.ceil(ms / 1000));
    const step = () => {
      const left = until - Date.now();
      if (left <= 0 || startCancelRef.current) {
        clearInterval(waitTimer);
        setPacingSeconds(null);
        resolve();
        return;
      }
      setPacingSeconds(Math.ceil(left / 1000));
    };
    const waitTimer = setInterval(step, 1000);
  }), []);

  /**
   * The ladder the Start button runs: ask for a call, and when the line accepts it and
   * then dies — which is what happens to a call started right after another one closed —
   * wait and ask again before anyone is told anything.
   *
   * The ladder stops at the seconds scale. A wait the server measured on this machine runs to
   * minutes and is spent with the button counting it down, not with the app dialing behind
   * the customer's back: he was just told to wait, and a call that opens itself five seconds
   * later contradicts the only sentence this screen has.
   */
  const runStartLadder = useCallback(async (tabName: TabName, needsVoice: boolean) => {
    // This machine is holding its wait. The buttons are disabled and show the count, so the
    // only press that reaches here is the OBS cable asking for a call on its own.
    if (holdUntilRef.current !== null) {
      toast({ title: t("Call ended"), description: holdMsgRef.current ?? endReasonMessage("lines_busy"), variant: "destructive" });
      return;
    }
    isStartingRef.current = true; setIsStarting(true);
    startCancelRef.current = false;
    // A trial is the only kind of call that puts a mark on his picture, so it is said at the
    // press that starts it: the card once per machine, then the ribbon on every trial call.
    // The voice-only tab sends no picture, so it has nothing to warn about.
    if (!account.paid && tabName !== "audio-only") {
      setTrialRibbonOff(false);
      let seen = false;
      try { seen = localStorage.getItem(TRIAL_CARD_SEEN) === "1"; } catch { seen = false; }
      if (!seen) {
        try { localStorage.setItem(TRIAL_CARD_SEEN, "1"); } catch { /* nowhere to remember: the card simply shows again next call */ }
        setTrialCard(true);
      }
    }
    try {
      let last: StartFailure | null = null;
      let tries = START_TRIES;
      for (let i = 0; i < tries; i++) {
        const failure = await attemptStart(tabName, needsVoice);
        if (!failure) return;
        last = failure;
        // Which line the gateway put this call on decides how many more asks it is worth.
        tries = startTriesFor(failure);
        // Write it down while it is still true what the engine said.
        if (failure.sessionId) reportCallFailure(failure.sessionId, failure.stage, failure.detail);
        const waitMs = startRetryWaitMs(failure, i, tries);
        if (waitMs === null) break;
        // The failed attempt ran a teardown, which released the page's "starting" flag;
        // a wait is not an idle page, or a second press would open two calls.
        isStartingRef.current = true;
        setConnStep("retry");
        await countedWait(waitMs);
        // Cancelled, or he left the page, while we waited. Starting his call after he
        // said no to it is worse than the failure itself.
        if (startCancelRef.current) return;
      }
      const f = last;
      if (!f) return;
      // A wait the server measured on this machine: its own number, held on the button.
      if (f.waitMs !== null) armHold(f.waitMs, startFailureMessage(f));
      if (f.reason === "out_of_minutes") {
        toast({ title: t("Out of minutes"), description: endReasonMessage(f.reason), variant: "destructive" });
        setLocation("/minutes");
        return;
      }
      // A refused old build is the one case where we can fix it ourselves: ask the
      // updater for the banner instead of leaving him stuck on a message with nowhere to go.
      if (f.reason === "update_required") getElectronAPI()?.checkForUpdate?.();
      toast({ title: t("Cannot start"), description: startFailureMessage(f), variant: "destructive", withContact: true });
    } finally {
      isStartingRef.current = false; setIsStarting(false); setConnStep(null); setPacingSeconds(null);
    }
  }, [attemptStart, toast, setLocation, countedWait, armHold, account.paid]);

  /**
   * Press of the one Start button on this page. Which call it dials is decided by the tab he is
   * standing on, and by nothing else: Video Call sends his own voice with the picture, Video +
   * Audio sends the picture with a cloned voice, Voice Only sends the cloned voice with no
   * picture at all. The answers this page gives before it asks for a call each cost the customer
   * less than a call that cannot do what its own tab promises: the administrator's tick, a trial
   * minute, no voice picked, and — on the two tabs that show one — a camera that is not running.
   */
  const handleStart = useCallback(async () => {
    if (isStartingRef.current || closingRef.current || streamingRef.current) return;
    // The card's listening check holds the microphone for a few seconds; a call must never
    // start while it has the device.
    micCheckRef.current?.stop();

    if (startBlocked !== null) {
      toast({ title: t("Cannot start"), description: startBlocked,
        variant: "destructive", withContact: cloneLocked }); return;
    }

    if (credsMissing) { setLocation(account.signedIn ? "/minutes" : "/account"); return; }
    // The Voice Only tab never asks for a camera: nothing it sends is a picture, and making him
    // enable one to go out with his voice alone is the mistake this split was made to remove.
    if (!voiceTab && (!cameraReady || !localStreamRef.current)) {
      toast({ title: t("Camera not ready"), description: t("Enable your camera first."), variant: "destructive" }); return;
    }
    // A voice-only call exists to put the cloned voice on the software microphone, and a picture
    // call exists to put the picture on the fake camera. Both are handed over by the call itself,
    // at the moment the line accepts it - see the switches lighting in attemptStart.
    await runStartLadder(activeTab, needsVoice);
  }, [credsMissing, cameraReady, voiceTab, activeTab, startBlocked, cloneLocked, needsVoice,
      toast, setLocation, account, runStartLadder]);

  // The one button that both dials and hangs up. Pressed while a call runs, it is his own hand
  // ending it, and that is the fact his panel needs — so it is written down here, on the way in,
  // and reported by the teardown this hands over to.
  const handleStop = useCallback(() => { stoppedByHandRef.current = true; teardownStream(); }, [teardownStream]);

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
    if (!account.signedIn) { toast({ title: t("Sign in required"), description: t("Open your account to sign in before uploading a voice."), variant: "destructive" }); return; }
    const name = uploadVoiceName.trim() || file.name.replace(/\.[^.]+$/, "");
    setUploadingVoice(true);
    try {
      const voice = await uploadVoice(name, file);
      addSavedVoice(voice);
      setSavedVoices(getSavedVoices());
      setVcVoiceId(voice.id);
      setUploadVoiceName("");
      toast({ title: t("Voice uploaded!"), description: t(`"{name}" is ready to use.`, { name: voice.name }) });
    } catch (err) {
      toast({ title: t("Upload failed"), description: toUserMessage(err, t("Could not upload the voice. Try again.")), variant: "destructive", withContact: true });
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
      // The picture windows carry their own Stop button, and a press there is his hand on the
      // same control — so it is recorded as his, not as a call that came down on its own.
      if (e.data === "stream-live-stop") { stoppedByHandRef.current = true; teardownStream(); }
      else if (e.data === "stream-live-reconnect") {
        // The cable came back and asked for its call. It gets the same kind of call back, which
        // is the one this tab dials — and a picture call needs his camera running first.
        if (startBlocked !== null) return;
        if (!voiceTab && !cameraReady) return;
        teardownStream();
        setTimeout(() => { void handleStart(); }, 300);
      }
    };
    window.addEventListener("message", h); return () => window.removeEventListener("message", h);
  }, [teardownStream, cameraReady, voiceTab, startBlocked, handleStart]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isFullscreen) { stoppedByHandRef.current = true; teardownStream(); setIsFullscreen(false); return; }
        closeAll(); if (isStreaming) { stoppedByHandRef.current = true; teardownStream(); } return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "f" || e.key === "F") { e.preventDefault(); setIsFullscreen(v => !v); }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [isStreaming, isFullscreen, teardownStream, closeAll]);

  const curStyle = STYLES.find(s => s.id === selectedStyle)!;
  const selectSt: React.CSSProperties = { width: "100%", appearance: "none", padding: "8px 32px 8px 12px", background: "hsl(222 47% 4%)", border: "1px solid hsl(222 40% 14%)", borderRadius: 8, color: "hsl(190 80% 96%)", fontSize: 13, fontFamily: "'Rajdhani',sans-serif", cursor: "pointer", opacity: isStreaming ? 0.5 : 1 };

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
      <>
      <div data-tour="screen" style={panelStyle}>
        {/* AI output video — always clean, no overlay chrome.
            objectFit:"cover" on the 9:16 panel IS the portrait rectangle the frame
            pump paints, so the preview and the caller's view match exactly, and only
            one element ever decodes the stream. */}
        <video
          ref={el => { remoteVideoRef.current = el; if (el && remoteStreamRef.current && el.srcObject !== remoteStreamRef.current) el.srcObject = remoteStreamRef.current; }}
          onPlaying={() => { if (firstFrameRef.current === null) firstFrameRef.current = Date.now(); paintedRef.current = true; markAirWhenReady(); }}
          autoPlay playsInline muted
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", transform: "scaleX(-1)" }} />

        {/* Idle placeholder */}
        {connStatus === "idle" && (
          <div style={{ position: "absolute", inset: 0, zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, background: "radial-gradient(ellipse at center, hsl(222 44% 8%) 0%, hsl(222 47% 4%) 100%)" }}>
            <Zap style={{ width: 32, height: 32, color: C }} />
            <p style={{ fontFamily: "'Orbitron',monospace", fontSize: 14, fontWeight: 700, color: "hsl(190 80% 96%)" }}>{t("AI Video Output")}</p>
            <p style={{ fontSize: 13, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", textAlign: "center", padding: "0 20px" }}>
              {isPortrait ? t("Portrait mode active") : t("Enable camera and click Start")}
            </p>
          </div>
        )}

        {/* Transient reconnect indicator — the call is still alive, giving WebRTC a chance to recover */}
        {connStatus === "reconnecting" && (
          <div style={{ position: "absolute", top: 12, left: 12, zIndex: 15, display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderRadius: 999, background: "rgba(0,0,0,0.72)", border: "1px solid rgba(0,210,211,0.5)", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif" }}>
            <Loader2 style={{ width: 14, height: 14, color: C, animation: "spin 1s linear infinite" }} /> {t("Reconnecting…")}
          </div>
        )}

        {/* The trial's mark, kept in view for as long as his calls run on free minutes.
            Its own x clears it for this call and it returns on the next one, so the reminder
            outlives the popup without becoming the thing he learns to click past. */}
        {!account.paid && activeTab !== "audio-only" && !trialRibbonOff && (isStarting || isStreaming) && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 16, display: "flex", alignItems: "center", gap: 12, maxWidth: "70%", padding: "10px 38px 10px 14px", borderRadius: 14, background: "hsl(222 44% 6% / 0.93)", border: "1.5px solid hsl(38 100% 58%)", boxShadow: "0 16px 40px rgba(0,0,0,0.6)" }}>
            <Sparkles style={{ width: 20, height: 20, color: "hsl(38 100% 58%)", flexShrink: 0 }} />
            <div>
              <p style={{ margin: 0, fontFamily: "'Orbitron',monospace", fontSize: 13, fontWeight: 700, letterSpacing: "0.04em", color: "hsl(38 100% 58%)" }}>{t("Trial minutes carry a watermark")}</p>
              <p style={{ margin: "3px 0 0", fontSize: 12, lineHeight: 1.5, fontWeight: 600, fontFamily: "'Rajdhani',sans-serif", color: "hsl(40 55% 90%)" }}>{t("Paid minutes carry none — the mark is gone the moment minutes are in your account.")}</p>
            </div>
            <button onClick={() => setTrialRibbonOff(true)} title={t("Close")}
              style={{ position: "absolute", top: 9, right: 9, width: 24, height: 24, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "1px solid hsl(38 100% 58% / 0.35)", color: "hsl(38 100% 75%)", cursor: "pointer", padding: 0 }}>
              <X style={{ width: 13, height: 13 }} />
            </button>
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
                  <p style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.5 }}>{t("In OBS → Sources → + → Window Capture → select \"Stream Live OBS\". For your voice add Sources → + → Audio Input Capture → \"")}{IS_MAC ? CABLE_NAME : "CABLE Output (VB-Audio Virtual Cable)"}".{IS_MAC ? t(" Then click Start Virtual Camera in OBS and pick “OBS Virtual Camera” in your call app.") : ""}</p>
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
                  <p style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.5 }}>{t("In OBS → Sources → + → Window Capture → select \"Stream Live OBS Portrait\" for a clean 9:16 feed.")}</p>
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
                title={isStreaming ? t("Stop the stream to turn off the camera") : t("Turn off camera")}
                disabled={isStreaming}
                style={{ position: "absolute", top: 4, right: 4, zIndex: 11, width: 22, height: 22, borderRadius: "50%", background: isStreaming ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.65)", border: "1px solid rgba(255,255,255,0.25)", color: isStreaming ? "rgba(255,255,255,0.35)" : "#fff", cursor: isStreaming ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                <CameraOff style={{ width: 12, height: 12 }} />
              </button>
            )}
            {!cameraReady && (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, background: "rgba(0,0,0,0.85)" }}>
                <Camera style={{ width: 18, height: 18, color: "hsl(222 25% 50%)" }} />
                <button onClick={() => startCamera()} style={{ fontSize: 10, color: C, fontWeight: 700, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>{t("Enable Camera")}</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Frame-rate readout — deliberately BELOW the panel. Nothing may sit on
          the AI picture: that frame is what OBS and the calling apps capture,
          and a customer's screenshot of it is what support has to work from.
          These three spans are written by the interval above, so updating them
          never re-renders this page. */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, fontSize: 11, fontFamily: "'Rajdhani',sans-serif", color: "hsl(222 25% 45%)" }}>
        <span ref={fpsCamRef}>{t("Camera —")}</span>
        <span>·</span>
        <span ref={fpsAiRef}>{t("AI picture —")}</span>
        <span ref={fpsHintRef} style={{ color: "hsl(38 95% 55%)", display: "none" }}>{t("The AI is sending fewer pictures than your camera.")}</span>
      </div>

      {/* Offscreen camera sink so the camera figure keeps counting in portrait,
          where the picture-in-picture box is not rendered. */}
      <video ref={camCountRef} autoPlay muted playsInline
        style={{ position: "fixed", left: -9999, top: 0, width: 4, height: 4, opacity: 0 }} />
      </>
    );
  };

  // ─── Portrait / Landscape toggle button (always outside the video panel) ───
  // Labelled with the mode clicking GIVES you, not the mode you're already in —
  // a button that only shows the current state reads like a status light, and
  // users did not know it switched anything.
  const OrientationToggle = () => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
      <button
        onClick={togglePortrait}
        title={portraitMode ? t("Switch back to widescreen (16:9)") : t("Switch to tall mobile-call view (9:16)")}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 16px", borderRadius: 10, cursor: "pointer",
          background: "hsl(222 40% 8%)", border: "1px solid hsl(222 40% 14%)",
          color: "hsl(190 80% 96%)",
          fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 10,
          letterSpacing: "0.06em", textTransform: "uppercase", transition: "all 0.2s",
        }}>
        {portraitMode
          ? <><Monitor style={{ width: 13, height: 13 }} /> {t("Switch to Landscape (16:9)")}</>
          : <><Smartphone style={{ width: 13, height: 13 }} /> {t("Switch to Portrait (9:16)")}</>}
      </button>
      <span style={{ fontSize: 10, color: portraitMode ? C : "hsl(222 25% 40%)", fontFamily: "'Rajdhani',sans-serif" }}>
        {portraitMode
          ? t("Portrait is live — calls and OBS receive your video tall")
          : t("Landscape is live — calls and OBS receive your video widescreen")}
      </span>
    </div>
  );

  // These panels are rendered by call ({StreamBtn()}) instead of as JSX elements.
  // Defined inside the render body, each one gets a brand new component identity
  // every render, so React destroys and rebuilds their DOM ~30x/s while streaming
  // (VU + delay + lease updates re-render this page). A button torn down between
  // mousedown and mouseup never fires onClick -- that is why Stop needed several
  // clicks. They hold no hooks, so inlining them is safe and keeps DOM identity.
  // ─── The one Start button ──────────────────────────────────────────────────
  // Design 2's single big control, and still the only one: it lives in the foot bar beside the
  // gear chips, and the tab he is standing on is what says which call it dials. The cloning tab
  // used to hold a second press beside this one — for the same voice, on the same cable — and
  // the two of them together are why this page was split into three tabs.
  const canStart = !credsMissing && !startBlocked && (voiceTab || cameraReady);
  const armed = canStart && !isStarting && !isClosing && holdSeconds === null;
  const StreamBtn = () => (
    <button data-tour="start"
      onClick={isStreaming ? handleStop : credsMissing ? () => setLocation(account.signedIn ? "/minutes" : "/account") : handleStart}
      disabled={!isStreaming && !armed}
      title={armed || isStreaming ? undefined : (startBlocked ?? undefined)}
      style={{
        flexShrink: 0, height: 52, padding: "0 30px", borderRadius: 999,
        background: isStreaming ? "hsl(0 85% 40% / 0.3)" : armed ? `linear-gradient(135deg, ${C} 0%, hsl(200 100% 45%) 100%)` : "hsl(222 40% 11%)",
        border: isStreaming ? "1px solid hsl(0 85% 55% / 0.5)" : "none",
        cursor: isStreaming || armed ? "pointer" : "not-allowed",
        color: isStreaming ? "hsl(0 85% 75%)" : armed ? "hsl(222 47% 4%)" : "hsl(222 25% 40%)",
        fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 14, letterSpacing: "0.08em", textTransform: "uppercase",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
        boxShadow: isStreaming ? "none" : armed ? "0 0 30px hsl(187 100% 52% / 0.35)" : "none",
      }}
      onMouseEnter={e => { if (isStreaming) (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.5)"; else if (armed) (e.currentTarget as HTMLElement).style.filter = "brightness(1.1)"; }}
      onMouseLeave={e => { if (isStreaming) (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.3)"; (e.currentTarget as HTMLElement).style.filter = "none"; }}>
      {isStreaming ? <><Square style={{ width: 17, height: 17 }} /> {voiceTab ? t("Stop voice call") : t("Stop")}</>
        : holdSeconds !== null ? <><Clock style={{ width: 17, height: 17 }} /> {t("Wait")} {formatTime(holdSeconds)}</>
        : isStarting ? <><Loader2 style={{ width: 17, height: 17, animation: "spin 1s linear infinite" }} /> {t("Starting…")}</>
        : isClosing ? <><Loader2 style={{ width: 17, height: 17, animation: "spin 1s linear infinite" }} /> {t("Ending call…")}</>
        : credsMissing ? <><Settings style={{ width: 17, height: 17 }} /> {t("Request credits")}</>
        : cloneLocked ? <><Lock style={{ width: 17, height: 17 }} /> {t("Cloning closed")}</>
        : cloneNeedsPaid ? <><Lock style={{ width: 17, height: 17 }} /> {t("Paid minutes needed")}</>
        : noVoiceChosen ? <><Lock style={{ width: 17, height: 17 }} /> {t("Choose a voice first")}</>
        : !voiceTab && !cameraReady ? <><Camera style={{ width: 17, height: 17 }} /> {t("Enable Camera")}</>
        : <>{voiceTab ? <Headphones style={{ width: 17, height: 17 }} /> : <Play style={{ width: 17, height: 17 }} />} {voiceTab ? t("Start voice call") : t("Start call")}</>}
    </button>
  );

  /** A foot-bar chip: the label, what is chosen, and a dot that says it is ready. */
  const BarChip = (tour: string, label: string, value: React.ReactNode, ready: boolean, wide = false) => (
    <div data-tour={tour || undefined} style={{ display: "flex", alignItems: "center", gap: 9, flexShrink: 0, padding: "9px 13px", borderRadius: 12, background: "hsl(222 44% 8%)", border: "1px solid hsl(222 40% 13%)", maxWidth: wide ? 260 : undefined }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", color: "hsl(222 25% 55%)" }}>{label}</span>
      <span style={{ fontSize: 11.5, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", color: "hsl(190 80% 92%)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{value}</span>
      <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: ready ? "hsl(150 80% 50%)" : "hsl(222 25% 30%)" }} />
    </div>
  );

  /** A foot-bar level bar, painted by the pipeline. */
  const BarLevel = (label: string, add: (el: HTMLDivElement | null) => void) => (
    <div style={{ width: 92, flexShrink: 0 }}>
      <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "'Rajdhani',sans-serif", color: "hsl(222 25% 50%)", marginBottom: 5 }}>{label}</p>
      <div style={{ height: 5, borderRadius: 3, overflow: "hidden", background: "hsl(222 40% 12%)" }}>
        <div ref={add} style={{ height: "100%", width: "0%", borderRadius: 3, transition: "width 0.06s linear", background: C }} />
      </div>
    </div>
  );

  // ─── Design 2: the look card, the sync card, and the console below ─────────────
  // His look and the shape of the picture sit under the stage, where he is already
  // looking; the measurement of his voice and the one box he types in stand in the
  // column beside it. Everything he reads once is laid out below, open.
  const glass: React.CSSProperties = {
    background: "hsl(228 62% 4% / 0.9)", backdropFilter: "blur(16px)",
    border: `1px solid ${C}3d`, borderRadius: 14,
    boxShadow: "0 18px 44px hsl(226 80% 2% / 0.6)",
  };
  const headLab: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace" };

  /** The nine styles he can be rendered in, under the picture. */
  const StyleCard = () => (
    <div style={glass}>
      <p style={{ ...headLab, padding: "15px 16px 13px" }}>
        {t("How you will look")}
      </p>
      <div data-tour="style" style={{ padding: "0 16px 16px" }}>
        <p style={{ ...headLab, marginBottom: 10 }}>{t("AI Style")}</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))", gap: 6 }}>
          {STYLES.map(s => (
            <button key={s.id} onClick={() => handleStyleSelect(s.id)}
              style={{ padding: "7px 4px", borderRadius: 8, cursor: "pointer", background: selectedStyle === s.id ? `${s.color}22` : "hsl(222 40% 8%)", border: `1px solid ${selectedStyle === s.id ? s.color + "66" : "hsl(222 40% 12%)"}`, color: selectedStyle === s.id ? s.color : "hsl(222 25% 55%)", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", fontFamily: "'Orbitron',monospace", boxShadow: selectedStyle === s.id ? `0 0 12px ${s.color}33` : "none" }}>
              {t(s.label)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  /** His own words about the look — empty unless he writes one, so the app never speaks for him. */
  const PromptCard = () => (
    <div data-tour="prompt" style={glass}>
      <p style={{ ...headLab, padding: "15px 16px 0" }}>{t("Custom Prompt")}</p>
      <div style={{ padding: "10px 16px 16px" }}>
        <textarea value={customPrompt} onChange={e => handleCustomPromptChange(e.target.value)} placeholder={t("Describe the look you want, in your own words")} rows={3}
          style={{ width: "100%", padding: 10, borderRadius: 8, resize: "vertical", background: "hsl(222 47% 4%)", border: "1px solid hsl(222 40% 14%)", color: "hsl(190 80% 96%)", fontSize: 12, fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5, outline: "none", boxSizing: "border-box" }}
          onFocus={e => { e.target.style.borderColor = "hsl(187 100% 52% / 0.5)"; }}
          onBlur={e => { e.target.style.borderColor = "hsl(222 40% 14%)"; }} />
        {customPrompt && <button onClick={() => handleCustomPromptChange("")} style={{ marginTop: 6, fontSize: 11, color: "hsl(222 25% 50%)", background: "none", border: "none", cursor: "pointer", fontFamily: "'Rajdhani',sans-serif" }}>{t("↺ Reset")}</button>}
      </div>
    </div>
  );

  /** The picture's shape, in the space under the stage. */
  const ShapeCard = () => (
    <div style={{ ...glass, display: "flex", flexDirection: "column", justifyContent: "center", gap: 10, padding: "14px 16px" }}>
      {OrientationToggle()}
    </div>
  );

  /**
   * What stays below the stage: the way out to Zoom / Teams / OBS, which he reads
   * across the room once and never again.
   */
  const Sheet = () => (
    <div style={{ marginTop: 20 }}>
      <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: "'Orbitron',monospace", marginBottom: 12 }}>
        {t("More settings")}
      </p>
      {renderBroadcastGuide()}
    </div>
  );

  /**
   * His photo, in the bar: the one place the reference face is set. It shows the picture
   * he chose, takes a new one on a tap, and takes it off again without a second control
   * anywhere else on the page.
   */
  const PhotoChip = () => (
    <div data-tour="ref" style={{ display: "flex", alignItems: "center", gap: 9, flexShrink: 0, padding: "7px 12px", borderRadius: 12, background: "hsl(222 44% 8%)", border: `1px solid ${refImagePreview ? `${C}55` : "hsl(222 40% 13%)"}` }}>
      <label title={t("Upload face reference to guide the AI")} style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", minWidth: 0 }}>
        {refImagePreview
          ? <img src={refImagePreview} alt="" style={{ width: 26, height: 26, borderRadius: 7, objectFit: "cover", flexShrink: 0 }} />
          : <Image style={{ width: 15, height: 15, color: "hsl(222 25% 45%)", flexShrink: 0 }} />}
        <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "'Rajdhani',sans-serif", color: "hsl(222 25% 50%)" }}>{t("My photo")}</span>
          <span style={{ fontSize: 11.5, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", color: "hsl(190 80% 92%)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{refImagePreview ? t("Reference Image") : t("Upload face reference")}</span>
        </span>
        <input type="file" accept="image/*" onChange={handleRefImage} style={{ display: "none" }} />
      </label>
      {refImagePreview && (
        <button onClick={() => { setRefImagePreview(null); setRefImageB64(null); }} style={{ width: 20, height: 20, borderRadius: "50%", flexShrink: 0, background: "hsl(0 85% 55% / 0.18)", border: "1px solid hsl(0 85% 55% / 0.4)", color: "hsl(0 85% 72%)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
          <X style={{ width: 10, height: 10 }} />
        </button>
      )}
    </div>
  );

  /** A device chosen from the bar: the name it picked, and the list to change it. */
  const DeviceChip = (kind: "camera" | "mic") => {
    const list = kind === "camera" ? cameras : mics;
    const chosen = kind === "camera" ? selectedCamId : selectedMicId;
    const pick = kind === "camera" ? handleCameraSwitch : (id: string) => chooseMic(id);
    const label = kind === "camera" ? t("Camera") : t("Microphone");
    const none = kind === "camera" ? t("No cameras found.") : t("No microphones found.");
    const Icon = kind === "camera" ? Camera : Mic;
    const ready = kind === "camera" ? cameraReady : list.length > 0;
    return (
      <div data-tour={kind === "camera" ? "camera" : undefined} style={{ display: "flex", alignItems: "center", gap: 9, flexShrink: 0, padding: "7px 12px", borderRadius: 12, background: "hsl(222 44% 8%)", border: "1px solid hsl(222 40% 13%)" }}>
        <Icon style={{ width: 15, height: 15, color: "hsl(222 25% 45%)", flexShrink: 0 }} />
        <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, maxWidth: 190 }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "'Rajdhani',sans-serif", color: "hsl(222 25% 50%)" }}>{label}</span>
          {list.length === 0 ? (
            <span style={{ fontSize: 11.5, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", color: "hsl(0 70% 65%)" }}>{none}</span>
          ) : (
            <select value={chosen} onChange={e => pick(e.target.value)} disabled={isStreaming}
              title={isStreaming ? t("Stop the call first — the device is locked while you are on air.") : t("Pick your {label}", { label: label.toLowerCase() })}
              style={{ background: "none", border: "none", padding: 0, color: "hsl(190 80% 92%)", fontSize: 11.5, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", cursor: isStreaming ? "not-allowed" : "pointer", outline: "none", textOverflow: "ellipsis", width: "100%" }}>
              {list.map((d, i) => <option key={d.deviceId} value={d.deviceId} style={{ background: "hsl(222 44% 8%)" }}>{d.label || (kind === "camera" ? t("Camera {n}", { n: i + 1 }) : t("Microphone {n}", { n: i + 1 }))}</option>)}
            </select>
          )}
        </span>
        <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: ready ? "hsl(150 80% 50%)" : "hsl(222 25% 30%)" }} />
      </div>
    );
  };

  /** On air: the clock he is being billed by, in the corner of the bar he is looking at. */
  const LiveChip = () => (
    isStreaming && connStatus === "connected" ? (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", borderRadius: 12, flexShrink: 0, background: "hsl(0 85% 55% / 0.1)", border: "1px solid hsl(0 85% 55% / 0.25)" }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "hsl(0 85% 65%)", animation: "pulse 2s ease-in-out infinite" }} />
        <span style={{ fontSize: 11.5, color: "hsl(0 85% 70%)", fontFamily: "'Orbitron',monospace", fontWeight: 700, whiteSpace: "nowrap" }}>{t("LIVE · {time}", { time: formatTime(elapsed) })}</span>
      </div>
    ) : null
  );


  // ─── Voice cloning panel ───────────────────────────────────────────────────
  // The card his cloned voice is chosen on, on both of the tabs that send one. It carries no
  // switch: the tab he is standing on is the choice of whether a call clones his voice, and a
  // second say on the same screen — one that governed only one of two Start presses — is the
  // confusion this page was rebuilt to end.
  const VoicePanel = () => (
    <div data-tour="voice" style={{ background: "hsl(228 62% 4% / 0.9)", backdropFilter: "blur(16px)", border: `1px solid ${cloneDead ? "hsl(187 100% 52% / 0.16)" : "hsl(265 90% 65% / 0.4)"}`, borderRadius: 14, padding: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: VC, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace" }}>{t("Voice Cloning")}</p>
          {vcActive && <span style={{ fontSize: 8, fontWeight: 700, color: "#fff", background: VC, padding: "2px 6px", borderRadius: 10, fontFamily: "'Orbitron',monospace" }}>{t("LIVE")}</span>}
        </div>
        <p style={{ fontSize: 10.5, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", margin: 0, maxWidth: 190, textAlign: "right", lineHeight: 1.45 }}>
          {voiceTab ? t("The voice you pick here is the only thing this call sends.")
                    : t("The voice you pick here goes out beside the picture.")}
        </p>
      </div>

      {cloneLocked && (
        <div style={{ padding: "8px 12px", borderRadius: 8, background: "hsl(265 90% 65% / 0.08)", border: "1px solid hsl(265 90% 65% / 0.25)", marginBottom: 10 }}>
          <p style={{ fontSize: 11, color: "hsl(265 60% 78%)", fontFamily: "'Rajdhani',sans-serif", display: "flex", alignItems: "center", gap: 8 }}>
            <Lock style={{ width: 13, height: 13, flexShrink: 0 }} />
            {endReasonMessage("clone_closed")}
          </p>
        </div>
      )}

      {cloneNeedsPaid && (
        <div style={{ padding: "8px 12px", borderRadius: 8, background: "hsl(265 90% 65% / 0.08)", border: "1px solid hsl(265 90% 65% / 0.25)", marginBottom: 10 }}>
          <p style={{ fontSize: 11, color: "hsl(265 60% 78%)", fontFamily: "'Rajdhani',sans-serif", display: "flex", alignItems: "center", gap: 8 }}>
            <Lock style={{ width: 13, height: 13, flexShrink: 0 }} />
            {endReasonMessage("clone_needs_paid_minutes")}
          </p>
        </div>
      )}

      {!voiceKeySet && (
        <div style={{ padding: "8px 12px", borderRadius: 8, background: "hsl(40 100% 52% / 0.08)", border: "1px solid hsl(40 100% 52% / 0.2)", marginBottom: 10 }}>
          <p style={{ fontSize: 11, color: "hsl(40 100% 75%)", fontFamily: "'Rajdhani',sans-serif" }}>
            {t("You have no minutes left. Ask your administrator to top up your account.")}
          </p>
        </div>
      )}

      {/* The two doors of one panel, side by side: the voice he goes out with, and the
          way to add his own right beside it. Nothing to hunt for under the fold. */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 10, alignItems: "stretch", opacity: cloneDead ? 0.42 : 1, pointerEvents: cloneDead ? "none" : undefined, filter: cloneDead ? "grayscale(0.9)" : undefined }}>
      <div style={{ background: "hsl(222 40% 8%)", borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <label style={{ display: "block", fontSize: 9.5, fontWeight: 700, color: "hsl(265 70% 60%)", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "'Orbitron',monospace", marginBottom: 6, lineHeight: 1.45 }}>{t("Clone Voice")}</label>
        <div style={{ position: "relative" }}>
          <select value={vcVoiceId} onChange={e => setVcVoiceId(e.target.value)} disabled={isStreaming} style={{ ...selectSt, borderColor: vcVoiceId ? "hsl(265 90% 65% / 0.4)" : "hsl(222 40% 14%)" }}>
            <option value="" disabled hidden>{t("Choose a voice")}</option>
            {savedVoices.length > 0 && (
              <optgroup label={t("── Your Voices ──")}>
                {savedVoices.map(v => <option key={v.id} value={v.id}>★ {v.name}</option>)}
              </optgroup>
            )}
            <optgroup label={t("── Built-in Voices ──")}>
              {BUILTIN_VOICES.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </optgroup>
          </select>
          <ChevronDown style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "hsl(222 25% 50%)", pointerEvents: "none" }} />
        </div>
        <p style={{ fontSize: 10, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.4, marginTop: "auto", paddingTop: 8 }}>
          {t("Your saved voices come first in this list.")}
        </p>
      </div>

      {/* Upload your own voice */}
      <div style={{ background: "hsl(222 40% 8%)", borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <p style={{ fontSize: 9.5, fontWeight: 700, color: "hsl(265 70% 60%)", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "'Orbitron',monospace", marginBottom: 6, lineHeight: 1.45 }}>{t("Upload Your Voice")}</p>
        <input
          type="text" placeholder={t("Voice name (optional)")}
          value={uploadVoiceName} onChange={e => setUploadVoiceName(e.target.value)}
          style={{ width: "100%", padding: "7px 8px", borderRadius: 7, background: "hsl(222 47% 4%)", border: "1px solid hsl(222 40% 14%)", color: "hsl(190 80% 96%)", fontSize: 11.5, fontFamily: "'Rajdhani',sans-serif", outline: "none", marginBottom: 7, boxSizing: "border-box" }}
          onFocus={e => { e.target.style.borderColor = "hsl(265 90% 65% / 0.5)"; }}
          onBlur={e => { e.target.style.borderColor = "hsl(222 40% 14%)"; }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 9px", borderRadius: 7, marginTop: "auto", cursor: uploadingVoice ? "not-allowed" : "pointer", background: uploadingVoice ? "hsl(222 40% 10%)" : "hsl(265 90% 65% / 0.15)", border: "1px solid hsl(265 90% 65% / 0.35)", color: VC, fontSize: 10.5, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.3 }}>
          {uploadingVoice ? <Loader2 style={{ width: 14, height: 14, flexShrink: 0, animation: "spin 1s linear infinite" }} /> : <Upload style={{ width: 14, height: 14, flexShrink: 0 }} />}
          {uploadingVoice ? t("Uploading…") : t("Upload Voice Sample (MP3/WAV/M4A)")}
          <input type="file" accept=".mp3,.wav,.m4a,audio/*" onChange={handleVoiceUpload} disabled={uploadingVoice} style={{ display: "none" }} />
        </label>
      </div>
      </div>
      <p style={{ fontSize: 10.5, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 9, lineHeight: 1.45 }}>
        {t("Upload 30s–3min of clear speech. It is saved and appears on the left for your next call.")}
      </p>

      {/* What he already saved: one chip per voice, tap it to go out with that voice. */}
      {savedVoices.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {savedVoices.map(v => (
            <span key={v.id} onClick={() => setVcVoiceId(v.id)} title={t("Use this voice")}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 9px", borderRadius: 999, cursor: "pointer", fontSize: 10.5, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", color: "hsl(190 80% 92%)", background: vcVoiceId === v.id ? "hsl(265 90% 65% / 0.15)" : "hsl(222 40% 8%)", border: `1px solid ${vcVoiceId === v.id ? "hsl(265 90% 65% / 0.4)" : "hsl(222 40% 12%)"}`, minWidth: 0 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 }}>★ {v.name}</span>
              <button onClick={e => { e.stopPropagation(); handleDeleteVoice(v.id); }}
                style={{ background: "none", border: "none", cursor: "pointer", color: "hsl(0 85% 55%)", padding: 0, display: "flex", flexShrink: 0 }}>
                <Trash2 style={{ width: 10, height: 10 }} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Waveform — the voice leaving the app, measured on the player itself.
          On the voice-only tab the same proof stands in its own card in the right column,
          so it is not printed twice on the one screen. */}
      {!voiceTab && vcActive && (
        <div style={{ marginTop: 8 }}>
          <p style={{ fontSize: 9, color: "hsl(222 25% 45%)", fontFamily: "'Orbitron',monospace", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>{t("Cloned Voice Output")}</p>
          <Waveform analyser={vcAnalyser} color={VC} height={60} />
          <div style={{ height: 5, background: "hsl(222 40% 11%)", borderRadius: 3, overflow: "hidden", marginTop: 6 }}>
            <div style={{ height: "100%", borderRadius: 3, transition: "width 0.08s", width: `${vcVu}%`, background: VC }} />
          </div>
          <p style={{ marginTop: 6, fontSize: 10, color: cloneAlive ? "hsl(265 60% 72%)" : "hsl(40 90% 62%)" }}>
            {cloneAlive
              ? t("This is the voice your callers and OBS are hearing. Your raw microphone is off the cable while the cloned voice is arriving.")
              : t("The cloned voice has stopped answering. The call closes in a few seconds rather than running with no voice for the people watching.")}
          </p>

          {/* The reading panel: what the voice service has been handed, what it has sent back,
              and where that audio goes. These figures are counted by the engine itself rather
              than read off the meters above, so a bar that moved on a piece which never reached
              the service can never be mistaken for an answer. */}
          <div style={{ marginTop: 9, padding: "10px 11px", borderRadius: 9, background: "hsl(222 40% 6%)", border: "1px solid hsl(265 90% 65% / 0.22)" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
              <p style={{ fontSize: 9, color: VC, fontFamily: "'Orbitron',monospace", textTransform: "uppercase", letterSpacing: "0.1em" }}>{t("Voice service readout")}</p>
              <p style={{ fontSize: 10.5, fontWeight: 700, color: "hsl(190 80% 92%)", fontFamily: "'Rajdhani',sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{allVoices.find(v => v.id === vcVoiceId)?.name ?? "—"}</p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
              {[
                [t("Your voice sent"), `${voiceRead.inS.toFixed(1)} s`],
                [t("Cloned voice back"), `${voiceRead.outS.toFixed(1)} s`],
                [t("Parts sent"), `${voiceRead.sent}`],
                [t("Parts answered"), `${voiceRead.back}`],
              ].map(([lab, val]) => (
                <div key={lab} style={{ padding: "6px 8px", borderRadius: 7, background: "hsl(222 47% 4%)", border: "1px solid hsl(222 40% 12%)" }}>
                  <p style={{ fontSize: 9, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.35 }}>{lab}</p>
                  <p style={{ fontSize: 12, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Orbitron',monospace" }}>{val}</p>
                </div>
              ))}
            </div>
            <p style={{ marginTop: 8, fontSize: 10, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.45 }}>
              {t("Last answer arrived in {ms} ms.", { ms: String(voiceRead.lastMs) })}{" "}
              {voiceTab || audioRouteOn
                ? t("It goes to your software microphone, so the calling app hears this voice and nothing else.")
                : t("Device routing is off, so it stays in your own speakers.")}
            </p>
          </div>
        </div>
      )}

      {/* On the voice-only tab this switch stands beside the readout it belongs to, so the
          column that shows what the clone is doing also holds the one thing that changes it. */}
      {!voiceTab && VoiceMonitorCard(true)}
    </div>
  );

  // ─── Local monitor — only meaningful where cloning actually runs ───────────
  const VoiceMonitorCard = (inPanel: boolean) => (
    <div style={{ marginTop: inPanel ? 10 : 0, background: "hsl(228 62% 4% / 0.9)", backdropFilter: "blur(16px)", border: `1px solid ${voiceMonitor ? "hsl(265 90% 65% / 0.35)" : "hsl(187 100% 52% / 0.24)"}`, borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: voiceMonitor ? "hsl(265 90% 65% / 0.15)" : "hsl(222 40% 10%)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Headphones style={{ width: 15, height: 15, color: voiceMonitor ? VC : "hsl(222 25% 45%)" }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em", marginBottom: 3 }}>{t("Hear my cloned voice")}</p>
          <p style={{ fontSize: 11, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.4 }}>
            {voiceMonitor
              ? t("On — the clone also plays in your own speakers. Wear headphones; loudspeakers let your mic feed it back into the call.")
              : t("Off — the clone goes to the calling app only. You hear yourself as usual.")}
          </p>
        </div>
        <button onClick={toggleVoiceMonitor} aria-pressed={voiceMonitor} title={t("Toggle local monitor")}
          style={{ flexShrink: 0, width: 46, height: 24, borderRadius: 14, border: "none", cursor: "pointer", background: voiceMonitor ? VC : "hsl(222 30% 20%)", position: "relative", transition: "background 0.15s" }}>
          <span style={{ position: "absolute", top: 3, left: voiceMonitor ? 25 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.15s" }} />
        </button>
      </div>
  );

  // ─── Voice service check — the one card on this tab that proves the clone is working ──
  // On a picture call the proof is the frame itself. A voice-only call has nothing to look at,
  // so this carries what the voice service is doing: the audio coming back from it, the two
  // levels either side of that service, and the four counts the engine keeps of its own pieces.
  // It stands here whether or not a call is running, because the question "is it working" is
  // asked before the dial as often as after it.
  const VoiceServiceCheck = () => (
    <div style={{ background: "hsl(228 62% 4% / 0.9)", backdropFilter: "blur(16px)", border: "1px solid hsl(265 90% 65% / 0.3)", borderRadius: 14, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
        <p style={{ fontSize: 10, fontWeight: 700, color: VC, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", margin: 0 }}>{t("Voice Service Check")}</p>
        <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 20, background: cloneAlive ? "hsl(265 90% 65% / 0.14)" : "hsl(222 40% 9%)", border: `1px solid ${cloneAlive ? "hsl(265 90% 65% / 0.4)" : "hsl(222 40% 14%)"}` }}>
          {cloneAlive ? <Wifi style={{ width: 10, height: 10, color: VC }} /> : <WifiOff style={{ width: 10, height: 10, color: "hsl(222 25% 40%)" }} />}
          <span style={{ fontSize: 9, fontWeight: 700, fontFamily: "'Orbitron',monospace", color: cloneAlive ? VC : "hsl(222 25% 40%)" }}>
            {cloneAlive ? t("Cloned voice on the line") : t("Idle")}
          </span>
        </div>
      </div>

      <p style={{ fontSize: 12, fontWeight: 700, color: "hsl(190 80% 92%)", fontFamily: "'Rajdhani',sans-serif", margin: "0 0 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {allVoices.find(v => v.id === vcVoiceId)?.name ?? "—"}
      </p>

      {vcActive ? (
        <Waveform analyser={vcAnalyser} color={VC} height={54} />
      ) : (
        <div style={{ height: 54, borderRadius: 8, background: "hsl(222 40% 7%)", border: "1px dashed hsl(265 90% 65% / 0.28)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", fontFamily: "'Orbitron',monospace", color: "hsl(222 25% 42%)" }}>{t("Waiting for the call")}</span>
        </div>
      )}

      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {[
          [t("Your voice → the clone"), addMicBar, t("into the voice service"), C] as const,
          [t("Cloned voice → your callers"), addCableBar, t("after the service"), VC] as const,
        ].map(([lab, barRef, hint, col]) => (
          <div key={lab}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em" }}>{lab}</span>
              <span style={{ fontSize: 10, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif" }}>{hint}</span>
            </div>
            <div style={{ height: 6, background: "hsl(222 40% 11%)", borderRadius: 3, overflow: "hidden" }}>
              <div ref={barRef} style={{ height: "100%", width: "0%", borderRadius: 3, transition: "width 0.06s linear", background: col }} />
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
        {[
          [t("Your voice sent"), `${voiceRead.inS.toFixed(1)} s`],
          [t("Cloned voice back"), `${voiceRead.outS.toFixed(1)} s`],
          [t("Parts sent"), `${voiceRead.sent}`],
          [t("Parts answered"), `${voiceRead.back}`],
        ].map(([lab, val]) => (
          <div key={lab} style={{ padding: "6px 8px", borderRadius: 7, background: "hsl(222 47% 4%)", border: "1px solid hsl(222 40% 12%)" }}>
            <p style={{ fontSize: 9, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.35, margin: 0 }}>{lab}</p>
            <p style={{ fontSize: 12, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Orbitron',monospace", margin: 0 }}>{val}</p>
          </div>
        ))}
      </div>

      <p style={{ marginTop: 9, fontSize: 10.5, color: vcActive ? "hsl(222 25% 55%)" : "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.45 }}>
        {vcActive
          ? <>{t("Last answer arrived in {ms} ms.", { ms: String(voiceRead.lastMs) })}{" "}
              {cloneAlive
                ? t("It goes to your software microphone, so the calling app hears this voice and nothing else.")
                : t("The cloned voice has stopped answering. The call closes in a few seconds rather than running with no voice for the people watching.")}</>
          : t("Press Start voice call. This card moves the moment the voice service answers — and if it never answers, these figures stay at zero and the call costs you nothing.")}
      </p>
    </div>
  );

  // ─── What this tab is, in the few lines that settle it ─────────────────────
  const VoiceOnlyNote = () => (
    <div style={{ background: "hsl(228 62% 4% / 0.9)", backdropFilter: "blur(16px)", border: "1px solid hsl(187 100% 52% / 0.24)", borderRadius: 14, padding: 16 }}>
      <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", margin: "0 0 10px" }}>{t("This call is voice only")}</p>
      <p style={{ fontSize: 11.5, color: "hsl(190 80% 92%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5, margin: "0 0 7px", display: "flex", gap: 7 }}>
        <span style={{ color: VC, flexShrink: 0 }}>✓</span>
        {t("Your cloned voice goes out the moment it is made — nothing is held back.")}
      </p>
      <p style={{ fontSize: 11.5, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5, margin: 0, display: "flex", gap: 7 }}>
        <span style={{ color: "hsl(222 25% 40%)", flexShrink: 0 }}>—</span>
        {t("No camera, no AI picture, and no lip-sync to measure.")}
      </p>
      <p style={{ fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.45, margin: "9px 0 0", paddingTop: 9, borderTop: "1px solid hsl(265 90% 65% / 0.18)" }}>
        {t("Minutes start when the cloned voice answers, not when you press Start.")}
      </p>
    </div>
  );

  // ─── Microphone behaviour card (the devices themselves are picked in the bar) ──
  const MicGateCard = () => (
    /* Microphone handling — automatic, nothing to switch on, and live before any call */
    <div data-tour="micgate" style={{ background: "hsl(228 62% 4% / 0.9)", backdropFilter: "blur(16px)", border: "1px solid hsl(187 100% 52% / 0.42)", borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: "hsl(187 100% 52% / 0.15)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Mic style={{ width: 15, height: 15, color: C }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em", marginBottom: 3 }}>{t("Microphone Handled Automatically")}</p>
        <div style={{ height: 6, background: "hsl(222 40% 11%)", borderRadius: 3, overflow: "hidden", margin: "5px 0 4px" }}>
          <div ref={addMicBar} style={{ height: "100%", width: "0%", borderRadius: 3, transition: "width 0.06s linear", background: C }} />
        </div>
        <p style={{ fontSize: 11, color: C, fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.4, minHeight: 15 }}>
          <span ref={addMicWord}>{t(MIC_CARD_WORDS.silent)}</span>
        </p>
        <p style={{ fontSize: 11, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.4, marginTop: 3 }}>
          {t("The AI always hears you the moment you open your mouth. What is held back is the room noise travelling out to your callers — nothing to switch on, nothing to set.")}
        </p>
      </div>
      {!isStreaming && (
        <button onClick={runMicCheck} disabled={micChecking}
          style={{ flexShrink: 0, background: "hsl(187 100% 52% / 0.12)", border: "1px solid hsl(187 100% 52% / 0.35)", borderRadius: 8, padding: "7px 10px", cursor: micChecking ? "default" : "pointer", color: C, fontSize: 10, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif" }}>
          {micChecking ? t("Listening…") : t("Check my microphone")}
        </button>
      )}
    </div>
  );

  // ─── Microphone input selector ─────────────────────────────────────────────
  // The Voice Only tab has no picture to point at, so the microphone he talks into is the
  // whole input. It gets its own panel here instead of only the chip in the bar, because on
  // this call picking the wrong one is the only way to ruin it. An empty pick is a real pick:
  // it means whatever the computer itself has set as the microphone.
  const MicInputCard = () => (
    <div data-tour="micinput" style={{ background: "hsl(228 62% 4% / 0.9)", backdropFilter: "blur(16px)", border: "1px solid hsl(265 90% 65% / 0.3)", borderRadius: 14, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: "hsl(265 90% 65% / 0.15)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Mic style={{ width: 14, height: 14, color: VC }} />
        </div>
        <p style={{ fontSize: 17, fontWeight: 800, color: VC, textTransform: "uppercase", letterSpacing: "0.10em", fontFamily: "'Orbitron',monospace" }}>{t("Microphone")}</p>
      </div>
      <p style={{ fontSize: 12, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.45, marginBottom: 10 }}>
        {t("Pick which microphone this call listens to.")}
      </p>
      {mics.length === 0 ? (
        <p style={{ fontSize: 12, fontWeight: 700, color: "hsl(0 70% 65%)", fontFamily: "'Rajdhani',sans-serif" }}>{t("No microphones found.")}</p>
      ) : (
        <select value={selectedMicId} onChange={e => chooseMic(e.target.value)} disabled={isStreaming}
          title={isStreaming ? t("Stop the call first — the device is locked while you are on air.") : t("Pick your {label}", { label: t("Microphone").toLowerCase() })}
          style={{ width: "100%", background: "hsl(222 40% 8%)", color: "hsl(190 80% 90%)", border: "1px solid hsl(222 40% 16%)", borderRadius: 8, padding: "8px 10px", fontSize: 12.5, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", cursor: isStreaming ? "not-allowed" : "pointer", outline: "none" }}>
          <option value="" style={{ background: "hsl(222 44% 8%)" }}>{t("System default microphone")}</option>
          {mics.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId} style={{ background: "hsl(222 44% 8%)" }}>{d.label || t("Microphone {n}", { n: i + 1 })}</option>
          ))}
        </select>
      )}
    </div>
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
        <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{t(label)}</span>
      </button>
    );
    return (
      <div data-tour="broadcast" style={{ background: "hsl(228 62% 4% / 0.9)", backdropFilter: "blur(16px)", border: "1px solid hsl(187 100% 52% / 0.24)", borderRadius: 14, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <p style={{ fontSize: 17, fontWeight: 800, color: C, textTransform: "uppercase", letterSpacing: "0.10em", fontFamily: "'Orbitron',monospace" }}>{t("Broadcast to Calls")}</p>
          <span style={{ fontSize: 12, fontWeight: 700, color: "hsl(190 70% 78%)", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.04em" }}>Zoom · Teams · Chrome · WhatsApp</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 10 }}>
          {showCamera && (IS_MAC ? (
            <div style={rowSt}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: "hsl(222 40% 10%)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Camera style={{ width: 14, height: 14, color: "hsl(222 25% 45%)" }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 14, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif" }}>Stream Live Camera</p>
                <p style={{ fontSize: 12, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.45 }}>
                  {t("On a Mac, AI video leaves through OBS Virtual Camera.")}
                </p>
              </div>
              <button onClick={() => setLocation("/settings")}
                style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 8, background: "hsl(187 100% 52% / 0.12)", border: "1px solid hsl(187 100% 52% / 0.35)", color: C, fontWeight: 700, fontSize: 12, fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em", cursor: "pointer" }}>
                {t("MAC SETUP")}
              </button>
            </div>
          ) : (
            <div style={rowSt}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: vcamEnabled ? "hsl(187 100% 52% / 0.15)" : "hsl(222 40% 10%)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Camera style={{ width: 14, height: 14, color: vcamEnabled ? C : "hsl(222 25% 45%)" }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 14, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif" }}>Stream Live Camera</p>
                <p style={{ fontSize: 12, color: vcamReady ? C : "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif" }}>
                  {!vcamSupported ? t("Driver layer unavailable") : vcamReady ? t("Live — a call app is receiving video") : vcamEnabled ? t("Waiting for a call app to open it…") : t("Off")}
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
              <p style={{ fontSize: 14, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif" }}>Stream Live Microphone</p>
              <p style={{ fontSize: 12, color: audioRouteOn ? VC : "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {audioRouteOn ? (cableSinkLabel ? t("Routing → {label}", { label: cableSinkLabel }) : t("Routing your voice to cable"))
                  : broadcastBlocked === "no-cable" ? t("Virtual microphone not detected")
                  : broadcastBlocked === "no-sink" ? t("This runtime can't select an output device.")
                  : t("Off — nothing reaches the cable")}
              </p>
            </div>
            {toggleBtn(audioRouteOn, toggleAudioRoute, false, "Toggle Stream Live Microphone")}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", flexShrink: 0 }}>{t("Audio out")}:</span>
            <select
              value={manualSinkId}
              onChange={e => chooseManualSink(e.target.value)}
              title={t("Which output your voice is sent to. Pick the {cable} entry if auto-detect fails.", { cable: CABLE_NAME })}
              style={{ flex: 1, minWidth: 0, background: "hsl(222 40% 8%)", color: "hsl(190 80% 90%)", border: "1px solid hsl(222 40% 16%)", borderRadius: 8, padding: "7px 9px", fontSize: 12, fontFamily: "'Rajdhani',sans-serif" }}>
              <option value="">{t("Auto-detect ({cable})", { cable: IS_MAC ? "BlackHole" : "VB-Cable" })}</option>
              {audioOutputs.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || t("Output {n} (unlabeled — likely {cable})", { n: i + 1, cable: IS_MAC ? "BlackHole" : "VB-Cable" })}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    );
  };

  // ─── The one card that says what to pick inside the call app ──────────────
  // Full width, big and bold: the customer reads this across the room while Zoom is
  // already open on the other screen.
  const renderBroadcastGuide = () => {
    const line: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: "hsl(190 80% 94%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.6 };
    return (
      <div style={{ background: "hsl(228 62% 4% / 0.9)", backdropFilter: "blur(16px)", border: "1px solid hsl(187 100% 52% / 0.42)", borderRadius: 14, padding: "18px 20px" }}>
        <p style={{ fontSize: 17, fontWeight: 800, color: C, textTransform: "uppercase", letterSpacing: "0.10em", fontFamily: "'Orbitron',monospace", marginBottom: 14 }}>
          {t("What to pick inside OBS / Zoom / Teams")}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: "10px 24px", alignItems: "start" }}>
          {IS_MAC ? (
            <>
              <p style={line}>{t("• VIDEO → ")}<span style={{ color: C }}>OBS Virtual Camera</span>{t(", once OBS is capturing the “Stream Live OBS” window and Start Virtual Camera is on.")}</p>
              <p style={line}>{t("• AUDIO (your voice) → ")}<span style={{ color: VC }}>{CABLE_NAME}</span>{t(" as the microphone. The app puts your voice in there itself — your physical mic is not needed as a second source.")}</p>
              <p style={line}>{t("• A Mac cannot host a system webcam without an Apple-approved extension, so video always goes through OBS here. Turn on “Stream Live Microphone” above and BlackHole carries your voice — or the ")}<span style={{ color: VC }}>{t("cloned voice")}</span>{t(" on the tabs where cloning is on.")}</p>
            </>
          ) : (
            <>
              <p style={line}>{t("• VIDEO → ")}<span style={{ color: C }}>Stream Live Camera</span>{t(" = the AI video. Your physical webcam is listed next to it — don't pick that one for AI.")}</p>
              <p style={line}>{t("• AUDIO (your voice) → ")}<span style={{ color: VC }}>CABLE Output (VB-Audio Virtual Cable)</span>{t(". On fresh installs it is named ")}<span style={{ color: VC }}>Stream Live Microphone</span>{t(" — same device, two possible names.")}</p>
              <p style={line}>{t("• Do ")}<span style={{ color: VC }}>{t("not")}</span>{t(" also add your Realtek / USB microphone as a second source. Your voice is already on that cable, and two copies of it arrive as echo.")}</p>
              <p style={line}>{t("• “Video Call” carries your natural voice, timed to the AI picture. On “Video + Audio”, with voice cloning on, the cable carries the ")}<span style={{ color: VC }}>{t("cloned voice")}</span>{t(" and your natural one steps aside — and if the cloned voice stops producing, your own microphone goes straight back onto it, so your callers never sit in silence.")}</p>
              <p style={line}>{t("• Wear headphones. Your microphone stays open while the cable is playing, and loudspeakers feed it back into the call.")}</p>
            </>
          )}
        </div>
        <p style={{ ...line, marginTop: 14, paddingTop: 12, borderTop: "1px solid hsl(187 100% 52% / 0.22)" }}>
          {IS_MAC ? (
            <>{t("OBS recipe: Sources → + → Window Capture → “Stream Live OBS”; then Sources → + → Audio Input Capture → “")}{CABLE_NAME}{t("”. If you hear echo, mute OBS “Desktop Audio”. Full steps: Settings → Mac Setup.")}</>
          ) : (
            <>{t("OBS recipe: Sources → + → Video Capture Device → “Stream Live Camera”; then Sources → + → Audio Input Capture → “CABLE Output (VB-Audio Virtual Cable)”. If you hear echo, mute OBS “Desktop Audio”.")}</>
          )}
        </p>
      </div>
    );
  };

  // ─── Audio sync status panel ───────────────────────────────────────────────
  // This card shows a measurement or it shows why there isn't one, and never a number that was
  // assumed. It also re-titles itself for the state it is in, because "MEASURING" on a call that is
  // running perfectly and "MEASURING" on a call that has no picture to compare are two different
  // problems and the customer has to be able to tell them apart from across the room.
  const AudioSyncPanel = () => (
    <div style={{ background: "hsl(228 62% 4% / 0.9)", backdropFilter: "blur(16px)", border: "1px solid hsl(187 100% 52% / 0.24)", borderRadius: 14, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace" }}>{t("Audio Sync")}</p>
        <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 20, background: audioActive ? "hsl(187 100% 52% / 0.12)" : "hsl(222 40% 9%)", border: `1px solid ${audioActive ? "hsl(187 100% 52% / 0.35)" : "hsl(222 40% 14%)"}` }}>
          {audioActive ? <Wifi style={{ width: 10, height: 10, color: C }} /> : <WifiOff style={{ width: 10, height: 10, color: "hsl(222 25% 40%)" }} />}
          <span style={{ fontSize: 9, fontWeight: 700, fontFamily: "'Orbitron',monospace", color: audioActive ? C : "hsl(222 25% 40%)" }}>
            {!audioActive ? t("IDLE") : voiceTab ? t("Voice Clone Only") : t(SYNC_BADGE[syncLive ? "live" : syncReason])}
          </span>
        </div>
      </div>
      {audioActive ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Mic style={{ width: 11, height: 11, color: C }} />
            <span style={{ fontSize: 11, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif" }}>{mics.find(m => m.deviceId === selectedMicId)?.label || "Microphone"}</span>
          </div>
          {/* A Voice Only call has no picture to line up with, so the delay figure is not merely
              unknown here — it does not apply. Showing "not measured" would read as a fault. */}
          {!voiceTab && (
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", borderRadius: 8, background: "hsl(222 40% 8%)", border: "1px solid hsl(222 40% 12%)" }}>
              <span style={{ fontSize: 12, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif" }}>{t("Lip-sync delay")}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: syncMeasured || syncLive ? C : "hsl(222 25% 45%)", fontFamily: "'Orbitron',monospace" }}>
                {syncLive ? t("none needed") : syncMeasured ? `${syncDelay.toFixed(2)}s` : t("not measured")}
              </span>
            </div>
          )}
          {/* The copy that OBS is handed, measured after the gate and after the hold. The
              microphone bar on the card above can only ever show the sound of the room, so this
              is the one that proves what your callers are actually getting. */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em" }}>{t("Voice going out to your callers")}</span>
              <span style={{ fontSize: 10, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif" }}>{t("after the delay")}</span>
            </div>
            <div style={{ height: 6, background: "hsl(222 40% 11%)", borderRadius: 3, overflow: "hidden" }}>
              <div ref={addCableBar} style={{ height: "100%", width: "0%", borderRadius: 3, transition: "width 0.06s linear", background: C }} />
            </div>
          </div>
          <p style={{ fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5 }}>
            {voiceTab
              ? t("There is no picture to line your voice up with, so nothing is held back — your cloned voice goes out the moment it is made.")
              : t(SYNC_WORDS[syncLive ? "live" : syncReason])}
          </p>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5 }}>
          {t("The AI hears you the moment you speak. Once a call starts, this card finds how late the avatar's mouth is behind your voice and holds your voice out to your callers by exactly that much. Until it has measured, nothing is held back.")}
        </p>
      )}
    </div>
  );

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    // The language switch rides in this page's own header: the corner it usually sits in is
    // where the minutes reading stands, and the two would cover each other.
    <AppLayout langInPage>
      {/* Cloned voice playback — routed to the virtual microphone so calling
          apps and OBS hear the persona voice instead of the raw mic. */}
      <audio ref={cloneAudioRef} autoPlay style={{ display: "none" }} />
      {/* Microphone playback into the same sink: this is what puts the streamer's own
          voice on the cable. It only ever holds a stream while routing is on, so the
          speakers never feed it back into the call. */}
      <audio ref={micRouteRef} autoPlay style={{ display: "none" }} />

      {/* Trial spent: say what the mark on the picture was, and where it ends. */}
      {account.signedIn && (
        <div style={{ margin: "16px 32px 0" }}>
          <WatermarkOffer
            paid={account.paid}
            videoMinutesLeft={videoLeft}
            ctaLabel={t("See the packages")}
            ctaHref="/plans"
          />
        </div>
      )}

      {/* Out-of-minutes banner */}
      {credsMissing && (
        <div style={{ margin: "16px 32px 0", padding: "12px 18px", borderRadius: 10, background: "hsl(40 100% 52% / 0.1)", border: "1px solid hsl(40 100% 52% / 0.35)", display: "flex", alignItems: "center", gap: 12 }}>
          <Settings style={{ width: 16, height: 16, color: "hsl(40 100% 62%)", flexShrink: 0 }} />
          <p style={{ fontSize: 13, color: "hsl(40 100% 75%)", fontFamily: "'Rajdhani',sans-serif", flex: 1 }}>
            {t("You have no minutes left. Ask your administrator to top up your account.")}
          </p>
          <button onClick={() => setLocation("/minutes")} style={{ padding: "6px 14px", borderRadius: 8, background: "hsl(40 100% 52% / 0.25)", border: "1px solid hsl(40 100% 52% / 0.5)", color: "hsl(40 100% 80%)", fontWeight: 700, fontSize: 12, fontFamily: "'Orbitron',monospace", cursor: "pointer" }}>
            {t("Request credits")}
          </button>
        </div>
      )}

      {/* Starting overlay */}
      {isStarting && (
        <div style={{ position: "fixed", inset: 0, zIndex: 55, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "absolute", inset: 0, backdropFilter: "blur(8px)", background: "hsl(222 47% 4% / 0.88)" }} />
          <div style={{ position: "relative", zIndex: 10, display: "flex", flexDirection: "column", alignItems: "center", gap: 20, maxWidth: 360, width: "100%", margin: "0 16px", textAlign: "center", padding: 36, borderRadius: 20, background: "hsl(222 44% 6%)", border: "1px solid hsl(187 100% 52% / 0.22)" }}>
            <Loader2 style={{ width: 40, height: 40, color: C, animation: "spin 1s linear infinite" }} />
            {pacingSeconds !== null ? (
              <div>
                <h3 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 16, color: "hsl(190 80% 96%)", marginBottom: 8 }}>{t("One moment…")}</h3>
                <p style={{ fontSize: 13, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif" }}>
                  {t("Your video line from the last call is still being released. Asking again in")}{" "}
                  {pacingSeconds} second{pacingSeconds === 1 ? "" : "s"}. {t("Nothing is being charged while you wait.")}
                </p>
              </div>
            ) : (
              <div>
                <h3 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 16, color: "hsl(190 80% 96%)", marginBottom: 8 }}>{t("Starting…")}</h3>
                <p style={{ fontSize: 13, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif" }}>
                  {connStep === "mic" ? t("Checking your microphone…")
                    : connStep === "engine" ? t("2/2 · Connecting to AI engine…")
                    : connStep === "voice" ? t("2/2 · Connecting your cloned voice…")
                    : connStep === "retry" ? t("2/2 · The video line didn't answer. Asking again…")
                    : t("1/2 · Authorizing your account…")}
                </p>
              </div>
            )}
            <button onClick={() => { startCancelRef.current = true; void teardownStream(); }} style={{ padding: "10px 20px", borderRadius: 8, width: "100%", background: "transparent", border: "1px solid hsl(187 100% 52% / 0.25)", color: "hsl(187 100% 52% / 0.8)", fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani',sans-serif", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <X style={{ width: 14, height: 14 }} /> {t("Cancel")}
            </button>
          </div>
        </div>
      )}

      {/* The trial's first saying, at the press that starts it. The call is not held up by this:
          it is dialled behind the card, and closing the card hands the reminder to the ribbon. */}
      {trialCard && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "absolute", inset: 0, backdropFilter: "blur(8px)", background: "hsl(222 47% 4% / 0.55)" }} />
          <div style={{ position: "relative", zIndex: 10, display: "flex", flexDirection: "column", alignItems: "center", gap: 20, maxWidth: 360, width: "100%", margin: "0 16px", textAlign: "center", padding: 36, borderRadius: 20, background: "hsl(222 44% 6%)", border: "1px solid hsl(38 100% 58% / 0.38)", boxShadow: "0 24px 70px rgba(0,0,0,0.7)" }}>
            <Sparkles style={{ width: 40, height: 40, color: "hsl(38 100% 58%)" }} />
            <div>
              <h3 style={{ margin: "0 0 10px", fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 17, lineHeight: 1.35, color: "hsl(38 100% 58%)" }}>{t("Trial minutes carry a watermark")}</h3>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, fontWeight: 600, fontFamily: "'Rajdhani',sans-serif", color: "hsl(40 55% 88%)" }}>{t("Paid minutes carry none.")}</p>
            </div>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, fontWeight: 500, fontFamily: "'Rajdhani',sans-serif", color: "hsl(222 25% 62%)" }}>
              {t("This call is on your free trial, so a mark sits on the AI picture. It is the only thing the trial limits. Your picture is arriving behind this — close it when you have read it.")}
            </p>
            <button onClick={() => setTrialCard(false)}
              style={{ padding: "11px 20px", borderRadius: 9, width: "100%", background: "hsl(38 100% 58%)", border: "none", color: "hsl(222 47% 6%)", fontWeight: 700, fontSize: 14, fontFamily: "'Rajdhani',sans-serif", cursor: "pointer" }}>
              {t("Close")}
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

      {/* ═══ Design 2 ═══════════════════════════════════════════════════════════
          One stage and one foot bar. The picture the AI draws is the screen; the few
          things he checks before pressing Start live in the bar under it; everything
          he sets once and forgets is folded behind "More settings". Nothing was
          dropped on the way — the fold holds the same panels, in the same order, and
          the walk-through opens it for him so every ring still has a target. */}
      <Stage minH="calc(100vh - 88px)">
        <div style={{ maxWidth: 1560, margin: "0 auto", paddingBottom: 168 }}>

          {/* Head: the call type he is buying, and his own minutes opposite it. */}
          <PageHead
            tour="tabs"
            name="Stream"
            badge={<LanguageMenu drop="left" />}
            pills={
              <PillRow>
                {TABS.map(tab => (
                  <Pill key={tab.id} active={activeTab === tab.id} label={tab.label} sub={tab.sub}
                    Icon={tab.Icon} color={tab.color}
                    onClick={() => { rememberTabPick(tab.id, mayUseTab(tab.id)); switchTab(tab.id); }} />
                ))}
              </PillRow>
            }
            card={<MinuteMeter modality={modalityForTab(activeTab)} note={cloneTab && !cloneDead
              ? voiceTab
                // The slow call is the one he is standing on, so its own speed is the figure
                // worth stating; the picture call's is nothing he needs to compare against here.
                ? t("The Voice Clone Only call spends them more slowly, because there is no picture to generate.")
                : t("A Video + Audio call runs your minutes down faster than the Video tab, because your cloned voice is generated alongside the picture.")
                  + (mayVoice ? " " + t("The Voice Clone Only call spends them more slowly, because there is no picture to generate.") : "")
              : undefined} />}
          />

          {voiceTab ? (
            /* His voice alone. There is no stage here, no shape, no look and no prompt — none of
               those draw anything, and this call sends nothing to be seen. So the left column is
               the voice he goes out with and the microphone feeding it, and the right column is
               the proof that the voice service is working: the audio coming back from it, the two
               levels either side of it, and the counts it keeps of its own pieces. Lip-sync has no
               place here — there is no picture for anything to be late against. */
            <div style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
                {VoicePanel()}
                {/* The microphone and how it is handled are one decision seen from two sides,
                    so they sit side by side instead of stacked half-empty. */}
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 14 }}>
                  {MicInputCard()}
                  {MicGateCard()}
                </div>
                {renderVirtualDevices(false)}
              </div>
              {/* The right column is the proof, not a control: what the voice service is doing
                  right now, the one switch that changes where it goes, and what this tab is.
                  Lip-sync has no place here — there is no picture to line anything up with. */}
              <div style={{ width: 336, flexShrink: 0, alignSelf: "flex-start", position: "sticky", top: 16, maxHeight: "calc(100vh - 40px)", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
                {VoiceServiceCheck()}
                {VoiceMonitorCard(false)}
                {VoiceOnlyNote()}
              </div>
            </div>
          ) : (
            <>
          {/* The stage: the AI picture takes the room. Under it come the settings he
              reaches for while looking at the frame — the shape, the microphone, his
              look — and in the corner stands the column he reads before pressing Start. */}
          <div style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
              {renderVideoOutput(true)}

              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.82fr) minmax(0, 1.55fr)", gap: 14, marginTop: 16, alignItems: "stretch" }}>
                {ShapeCard()}
                {MicGateCard()}
              </div>

              {/* On the cloning tab the OBS switches stand beside his look; on the
                  natural-voice tab they close the column instead, so both sides end together. */}
              <div style={{ display: "grid", gridTemplateColumns: comboTab ? "minmax(0, 0.86fr) minmax(0, 1.14fr)" : "minmax(0, 1fr)", gap: 14, marginTop: 14, alignItems: "stretch" }}>
                {StyleCard()}
                {comboTab && renderVirtualDevices(true)}
              </div>
            </div>

            <div style={{ width: 336, flexShrink: 0, alignSelf: "flex-start", position: "sticky", top: 16, maxHeight: "calc(100vh - 40px)", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
              {comboTab && VoicePanel()}
              {AudioSyncPanel()}
              {PromptCard()}
              {!comboTab && renderVirtualDevices(true)}
            </div>
          </div>
            </>
          )}

          {Sheet()}
        </div>
      </Stage>

      {/* The bar, floating over the foot of the stage on every tab. */}
      <div style={{ position: "fixed", left: `calc(${RAIL_W}px + (100vw - ${RAIL_W}px) / 2)`, transform: "translateX(-50%)", bottom: 16, zIndex: 60, width: `min(1500px, calc(100vw - ${RAIL_W}px - 40px))`, display: "flex", flexDirection: "column", gap: 8 }}>
        {/* A free minute is the one thing worth interrupting the layout for. */}
        {!isStreaming && trialWaiting && (
          <div data-tour="trial" style={{ display: "flex", alignItems: "center", gap: 8, alignSelf: "center", padding: "8px 12px", borderRadius: 10, background: "hsl(187 100% 52% / 0.1)", border: "1px solid hsl(187 100% 52% / 0.3)" }}>
            <Sparkles style={{ width: 14, height: 14, color: C, flexShrink: 0 }} />
            <p style={{ fontSize: 12, color: "hsl(187 60% 85%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.45, margin: 0 }}>
              {t("You have free minutes waiting. They don't expire — press")} <b style={{ color: "hsl(190 80% 96%)" }}>{t("Start")}</b> {t("whenever you're ready.")}
            </p>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "center", padding: "10px 12px", borderRadius: 16, background: "hsl(228 62% 4% / 0.9)", backdropFilter: "blur(16px)", border: `1px solid ${voiceTab ? "hsl(265 90% 65% / 0.45)" : `${C}3d`}`, boxShadow: "0 18px 44px hsl(226 80% 2% / 0.6), 0 0 30px hsl(187 100% 52% / 0.1)" }}>
          {LiveChip()}
          {/* The Voice Only tab sends no picture, so the two chips that set one are not on it at
              all — nobody is shown a camera he has no use for. */}
          {!voiceTab && PhotoChip()}
          {!voiceTab && DeviceChip("camera")}
          {DeviceChip("mic")}
          {BarLevel(t("Your Voice (Input)"), addMicBar)}
          {BarLevel(t("Output level"), addCableBar)}
          <MinuteMeter modality={modalityForTab(activeTab)} compact />
          {StreamBtn()}
        </div>
      </div>

      {/* The walk-through. Never over a live or starting call — it moves the tabs about,
          and a stop that lands mid-call would cost the customer real minutes. */}
      {tourOpen && !isStreaming && !isStarting && !account.live && (
        <GuidedTour
          stops={tourStops(tourHasTrial)}
          tab={activeTab}
          onTab={id => setActiveTab(id)}
          contact={tourContact}
          onClose={() => setTourOpen(false)}
        />
      )}

      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}`}</style>
    </AppLayout>
  );
}
