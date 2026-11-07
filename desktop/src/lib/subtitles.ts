// Reading the caller's words out of the sound of the call.
//
// The caller is not in this app. He is on the other end of whatever calling program the seller
// opened - a video call, a voice call - and his voice reaches this machine only as sound coming out
// of the speaker the seller is already listening through. So this file takes a PASSIVE COPY of that
// sound: it never redirects what he hears, never touches his microphone, and never asks the calling
// app for anything. The copy is read for words, and the words are put on the screen.
//
// What it deliberately is not:
//   * not a second voice. Nothing here speaks, nothing here is billed, and no minute is drawn -
//     the call is already metered by the lease the reading rides on.
//   * not part of the call's health. If the copy cannot be opened, if the reader is refused, or if
//     the translator answers late, the line says so on the card and the CALL CARRIES ON EXACTLY AS
//     IT DID. A subtitle that never arrived is a disappointment; a call that stopped because of one
//     would be a fault this app caused.
//   * not a listener on his own voice. The seller's cloned answer comes out of the same speakers
//     whenever he is monitoring rather than broadcasting, so the words this app has just put on air
//     are held here and refused on the way back in.

import { pieceHasSignal, pieceTrim } from "./voice-piece";
import { speakableWords } from "./transcript";
import { VoiceGate, voiceBandLevel } from "./voicegate";
import { t } from "./i18n";

// The same reader the cloned voice is built on, asked for the caller rather than the seller.
const READER_MODEL = "scribe_v2";

// One turn of the caller, in wall-clock terms. Longer than a sentence and short enough that a
// line of text never sits unchanged for half a minute.
const MAX_TURN_MS   = 8000;
const MIN_SPEECH_MS = 350;
const QUIET_CUT_MS  = 900;
const IDLE_CUT_MS   = 2500;
const TICK_MS       = 100;

// A turn that has not come back inside this window is not shown later. Subtitles are read at the
// speed they are said; a line that arrives nine seconds after the words it carries is worse than
// no line, because the seller has already answered.
const TURN_DEADLINE_MS = 6000;

// How many turns may be with the reader at once. Two is enough to cover a slow trip, and more
// would only queue up words nobody is waiting for.
const MAX_IN_FLIGHT = 2;

// The last answers this app put on air, kept only long enough to recognise one coming back in.
const ANSWER_MEMORY = 6;
const ANSWER_AGE_MS = 20000;

/** The line as the screen and the floating bar want it. */
export type SubtitleView = {
  /** What the caller said, in the language the card asked for. */
  text: string;
  /** The words as they arrived, kept only when they differ from what is shown. */
  asSaid: string;
  /** The two-letter name of the language heard, upper-case, for the chip. */
  heard: string;
  /** The language now being shown: the code the card holds, or "" for the seller's own. */
  to: string;
};

function norm(words: string): string[] {
  return words.toLowerCase().replace(/[^a-zà-ÿ\s]/g, " ").split(/\s+/).filter(w => w.length > 1);
}

/**
 * Do these two lines of words mean the same turn? Used only to refuse the app's own voice coming
 * back through the speakers, so it may be generous: a shared majority of the same words in either
 * direction is enough. Real conversation never repeats a whole sentence like that.
 */
export function sameTurn(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (x.length < 2 || y.length < 2) return false;
  const set = new Set(x);
  let hits = 0;
  for (const w of y) if (set.has(w)) hits++;
  const shareY = hits / y.length;
  const set2 = new Set(y);
  let hits2 = 0;
  for (const w of x) if (set2.has(w)) hits2++;
  return shareY > 0.6 || hits2 / x.length > 0.6;
}

/**
 * The passive copy of whatever is already coming out of the machine's speakers.
 *
 * It is asked for by the screen that is already allowed to open a microphone, on the same
 * permission the app has held since its first call, and it is handed back with the picture track
 * thrown away - the picture is only what the door needs to be opened, and nothing here looks
 * through it. Null means this machine will not hand over a copy, which the card says plainly
 * rather than showing a subtitle that never comes.
 */
export async function speakerCopy(sourceId: string): Promise<MediaStream | null> {
  if (!sourceId || !navigator.mediaDevices?.getUserMedia) return null;
  const mandatory = { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory } as unknown as MediaTrackConstraints,
      audio: { mandatory } as unknown as MediaTrackConstraints,
    });
    const audio = stream.getAudioTracks();
    stream.getVideoTracks().forEach(t => t.stop());
    if (!audio.length) { stream.getTracks().forEach(t => t.stop()); return null; }
    return new MediaStream(audio);
  } catch {
    return null;
  }
}

export class CallerReader {
  /** The voice relay, the same one the cloned voice is read through. */
  ask: ((path: string, body: FormData) => Promise<Response>) | null = null;
  /** The language hop, the same one his answers use. */
  change: ((words: string, from: string, to: string) => Promise<{ text: string | null; reason: string | null }>) | null = null;
  onTurn: ((v: SubtitleView) => void) | null = null;
  /** Why the line is not working, in one sentence for the card. */
  onFault: ((why: string) => void) | null = null;

  /** "" = the seller's own language, "*" = leave the caller's words as they were said. */
  target = "";
  /** The seller's own language, as a two-letter code. */
  myLang = "en";

  running = false;

  private ctx: AudioContext | null = null;
  private recorder: MediaRecorder | null = null;
  private pump: ReturnType<typeof setInterval> | null = null;
  private gate = new VoiceGate();
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: Blob[] = [];
  private cutting = false;
  private inFlight = 0;
  private speechMs = 0;
  private quietMs = 0;
  private pieceMs = 0;
  private gen = 0;
  private answers: Array<{ text: string; at: number }> = [];

  /**
   * The words this app has just put on air, in the seller's own voice. They are the only sound on
   * the copy that is not the caller, and they are the one thing a subtitle line must never show.
   */
  noteAnswer(text: string): void {
    if (!text) return;
    this.answers.push({ text, at: Date.now() });
    if (this.answers.length > ANSWER_MEMORY) this.answers.splice(0, this.answers.length - ANSWER_MEMORY);
  }

  async start(stream: MediaStream): Promise<boolean> {
    if (this.running) return true;
    if (!stream.getAudioTracks().length) return false;
    this.running = true;
    this.gen += 1;
    this.inFlight = 0; this.cutting = false;
    this.speechMs = 0; this.quietMs = 0; this.pieceMs = 0;
    this.chunks = [];
    this.gate.reset();

    const ctx = new AudioContext();
    if (ctx.state !== "running") { try { await ctx.resume(); } catch { /* the copy still runs */ } }
    this.ctx = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    an.minDecibels = -90; an.maxDecibels = -10;
    src.connect(an);
    this.analyser = an;
    this.freq = new Uint8Array(an.frequencyBinCount);

    this.recorder = makeRecorder(stream);
    this.recorder.ondataavailable = ev => { if (ev.data.size > 0) this.chunks.push(ev.data); };
    this.recorder.onstop = () => {
      this.cutting = false;
      if (!this.running) return;
      const blob = new Blob(this.chunks.splice(0), { type: "audio/webm" });
      // Judged on the piece that just closed, before its own counts are cleared for the next one.
      const worth = blob.size > 0 && this.speechWorthReading();
      this.speechMs = 0; this.quietMs = 0; this.pieceMs = 0;
      try { this.recorder?.start(1000); } catch { /* the piece above is the last one */ }
      if (worth) void this._read(blob, this.gen);
      else this.inFlight = Math.max(0, this.inFlight - 1);
    };
    this.recorder.start(1000);
    this.pump = setInterval(() => this._tick(), TICK_MS);
    return true;
  }

  stop(): void {
    this.running = false;
    if (this.pump) { clearInterval(this.pump); this.pump = null; }
    try { if (this.recorder && this.recorder.state === "recording") this.recorder.stop(); } catch { /* already gone */ }
    this.recorder = null;
    try { void this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null;
    this.chunks = [];
    this.answers = [];
  }

  /** A turn is only worth a request when a person was actually talking in it. */
  private speechWorthReading(): boolean {
    return this.speechMs >= MIN_SPEECH_MS;
  }

  private _tick(): void {
    if (!this.running || !this.analyser || !this.freq || !this.ctx) return;
    this.analyser.getByteFrequencyData(this.freq);
    const level = voiceBandLevel(this.freq, this.ctx.sampleRate);
    this.gate.update(level, TICK_MS / 1000);
    this.pieceMs += TICK_MS;
    if (this.gate.voiced) { this.speechMs += TICK_MS; this.quietMs = 0; }
    else this.quietMs += TICK_MS;

    if (this.cutting || this.inFlight >= MAX_IN_FLIGHT) return;
    const done = this.speechMs >= MIN_SPEECH_MS &&
      (this.quietMs >= QUIET_CUT_MS || this.pieceMs >= MAX_TURN_MS);
    if (done || (this.speechMs === 0 && this.pieceMs >= IDLE_CUT_MS)) this._cut();
  }

  private _cut(): void {
    if (!this.recorder || this.recorder.state !== "recording") return;
    this.inFlight += 1;
    this.cutting = true;
    try { this.recorder.stop(); }
    catch { this.cutting = false; this.inFlight = Math.max(0, this.inFlight - 1); }
  }

  /** The piece as the raw 16-bit, 16 kHz mono samples the reader answers fastest on. */
  private async _pcm(blob: Blob): Promise<ArrayBuffer | null> {
    if (!this.ctx) return null;
    const decoded = await this.ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const frames = Math.max(1, Math.ceil(decoded.duration * rate));
    const off = new OfflineAudioContext(1, frames, rate);
    const node = off.createBufferSource();
    node.buffer = decoded; node.connect(off.destination); node.start();
    const samples = (await off.startRendering()).getChannelData(0);
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out.buffer;
  }

  private async _read(blob: Blob, gen: number): Promise<void> {
    try {
      if (!this.running || !this.ask || gen !== this.gen) return;
      const raw = await this._pcm(blob);
      if (!raw || !this.running || gen !== this.gen) return;
      // An empty room is not a sentence, and asking about it costs the seller nothing he can see.
      if (!pieceHasSignal(raw)) return;
      const span = pieceTrim(raw);
      if (!span) return;
      const pcm = span.from === 0 && span.to * 2 === raw.byteLength
        ? raw : raw.slice(span.from * 2, span.to * 2);

      const form = new FormData();
      form.append("file", new Blob([pcm], { type: "application/octet-stream" }), "caller.pcm");
      form.append("model_id", READER_MODEL);
      form.append("file_format", "pcm_s16le_16");
      form.append("timestamps_granularity", "none");
      form.append("diarize", "false");

      const asked = this.ask("/v1/speech-to-text", form);
      const res = await Promise.race([
        asked,
        new Promise<null>(r => setTimeout(() => r(null), TURN_DEADLINE_MS)),
      ]);
      if (!this.running || gen !== this.gen) return;
      if (!res || !res.ok) {
        // The detail is his to read in the app's own log, never a customer's sentence: what goes on
        // the card says what happened to their words and that the call itself was not touched.
        console.warn(`[subtitles] the reading step did not answer: ${res ? `HTTP ${res.status}` : "nothing inside the wait"}`);
        this._fault(res && (res.status === 401 || res.status === 403)
          ? t("This account is not allowed to read their words as text.")
          : t("Their words could not be read just now. Your call is not affected."));
        return;
      }
      const j = await res.json().catch(() => null) as { text?: unknown; language_code?: unknown } | null;
      const said = typeof j?.text === "string" ? j.text : "";
      // The same rule the cloned voice has held since 1.8.48: a description of the room is not a
      // sentence. Here it would be worse than a sentence - it would be a subtitle about a fan.
      const words = speakableWords(said);
      if (!words) return;
      const heard = typeof j?.language_code === "string" ? j.language_code.trim().toLowerCase() : "";
      // His own answer, come back through his speakers.
      const now = Date.now();
      this.answers = this.answers.filter(a => now - a.at < ANSWER_AGE_MS);
      if (this.answers.some(a => sameTurn(a.text, words))) return;

      const to = this.target === "*" ? "" : (this.target || this.myLang);
      let shown = words;
      if (to && heard && to !== heard) {
        const changed = this.change ? await this.change(words, heard, to) : null;
        // A translation that will not answer is not a reason to hide what the caller said: the
        // words go up in the language they arrived in, and the card already says how often.
        if (changed?.text) shown = changed.text;
      }
      if (!this.running || gen !== this.gen) return;
      this.onTurn?.({
        text: shown,
        asSaid: shown !== words ? words : "",
        heard,
        to,
      });
    } catch {
      // Nothing in this path may reach the call. A reader that throws is a reader that says so on
      // the card and leaves the line, the meter and the voice exactly as they were.
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  private _fault(why: string): void {
    this.onFault?.(why);
  }
}

/** A recording of the copy, in one-second slices, so a turn can be closed whenever it ends. */
function makeRecorder(stream: MediaStream): MediaRecorder {
  const types = ["audio/webm;codecs=opus", "audio/webm"];
  const mime = types.find(t => MediaRecorder.isTypeSupported(t)) ?? "";
  return mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
}
