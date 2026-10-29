// A whole call, painted. This is the model both the offline checks and the threshold probe drive: the
// avatar's picture as a stream of real frames, reduced to movement by the app's own `bandMotion`,
// against his microphone as a stream of real levels. Every figure the lip-sync rule is proved against
// is therefore a figure the app can actually see and hear - not one somebody typed into a test.
//
// Keep it here rather than inside a check, because a simulation forked into two files is two
// simulations, and only one of them would be telling the truth.
import { AVATAR_BAND, FRAME_H, FRAME_W, bandMotion } from "../src/lib/face-motion";
import { LipSyncEstimator } from "../src/lib/lipsync";
import { conversation, newFrame, renderFace, speechAt, type Utterance } from "./face-sim";

/** How often the app samples the picture and the microphone. ~16 times a second. */
export const DT = 0.06;

export interface Call {
  /** How late the avatar's mouth really is behind his voice. */
  lag: number;
  seconds: number;
  /** How the man talks: the fraction of the call spent in words, and when he starts. */
  talk?: number;
  first?: number;
  seed?: number;
  /** A run of words he has already chosen, instead of a generated conversation. */
  us?: Utterance[];
  /** How loud he is, 0..1 - a man speaking softly moves his microphone barely at all. */
  voiceAmp?: number;
  /** How much of his mouth the engine reproduces. */
  avatarAmp?: number;
  /** How much the avatar's head wanders, on a clock of its own. */
  avatarMove?: number;
  /** The engine slows down from this moment. */
  lagFrom?: { at: number; lag: number };
  /** How many times a second the picture is actually repainted. */
  fps?: number;
  /** When the picture lands, rather than being there from the first second. */
  pictureFrom?: number;
  /** The avatar's mouth answers somebody else: a recorded loop, a second voice, a broken engine. */
  ownRhythm?: boolean;
  /** The picture is on screen but nothing in it ever moves. */
  frozen?: boolean;
  /** The stream drops out for this long, mid-call: a reconnect, a tab left and come back to. */
  lose?: { at: number; seconds: number };
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Head and jaw wander, two frequencies so it is never a metronome. */
function head(t: number, amp: number): { d: number; b: number } {
  return {
    d: (Math.sin(t * 0.53) * 0.6 + Math.sin(t * 1.37 + 0.4) * 0.3) * amp,
    b: (Math.sin(t * 0.41 + 1.1) * 0.5 + Math.sin(t * 1.13 + 2.2) * 0.25) * amp,
  };
}

/** Blinks, because an idle face still moves without anybody talking. */
function blinks(seconds: number, seed: number): number[] {
  let s = (seed ^ 0x5bf03635) >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out: number[] = [];
  let t = 2 + rand() * 3;
  while (t < seconds) { out.push(t); t += 2.2 + rand() * 5; }
  return out;
}

function shut(at: number, bs: number[]): number {
  for (const b of bs) {
    const d = at - b;
    if (d >= 0 && d < 0.22) return d < 0.09 ? d / 0.09 : 1 - (d - 0.09) / 0.13;
  }
  return 0;
}

/** Sensor and compression grain: the noise a downscaled frame carries, at several times its level, so
 *  the proof is harder than the call rather than easier. */
function grain(px: Uint8ClampedArray, tick: number): void {
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      let h = (x * 374761393 + y * 668265263 + tick * 2246822519 + 23 * 3266489917) >>> 0;
      h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
      const v = (((h ^ (h >>> 16)) >>> 0) / 4294967295 - 0.5) * 3;
      const i = (y * FRAME_W + x) * 4;
      px[i] = Math.max(0, Math.min(255, px[i] + v));
      px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + v));
      px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + v));
    }
  }
}

function black(px: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) { px[i] = 6; px[i + 1] = 6; px[i + 2] = 8; px[i + 3] = 255; }
}

/**
 * Replay one call through the estimator the app runs. `lockAt` is the first moment it claims a figure -
 * how long a customer waits before the card can say anything true.
 */
export function replay(
  c: Call, onTick?: (est: LipSyncEstimator, at: number) => void,
): { est: LipSyncEstimator; lockAt: number } {
  const seed = c.seed ?? 7;
  const us = c.us ?? conversation(c.seconds, seed, c.talk ?? 0.4, c.first ?? 3);
  const own = c.ownRhythm ? conversation(c.seconds, (seed * 2654435761) >>> 0, 0.55, 4.5) : null;
  const bs = blinks(c.seconds + 8, seed);
  const voiceAmp = c.voiceAmp ?? 1;
  const avatarAmp = c.avatarAmp ?? 0.85;
  const avatarMove = c.avatarMove ?? 0.45;
  const frame = c.fps ? 1 / c.fps : 0;
  const pictureFrom = c.pictureFrom ?? 0;

  const est = new LipSyncEstimator();
  const pix = newFrame(), prev = newFrame();
  let lockAt = -1, shownAt = -1;

  for (let i = 0; i * DT <= c.seconds; i++) {
    const at = i * DT;
    const lag = c.lagFrom && at >= c.lagFrom.at ? c.lagFrom.lag : c.lag;
    const lost = !!c.lose && at >= c.lose.at && at < c.lose.at + c.lose.seconds;

    // His microphone: his words, and the room floor no gate ever quite loses.
    const voice = Math.max(0, speechAt(at, us) * voiceAmp)
      + 0.012 + 0.006 * Math.abs(Math.sin(at * 5.3)) + 0.004 * shut(at, bs);

    // The avatar's picture: his words `lag` later, painted by an engine that is quieter about his
    // mouth, wanders its own head, only repaints when it gets around to it, goes black before the
    // picture lands, and drops out altogether when the stream does.
    const shown = at >= pictureFrom && !lost;
    const edge = frame ? Math.floor(at / frame) : i;
    if (edge !== shownAt) {
      shownAt = edge;
      if (!shown) black(pix);
      else {
        const src = own ?? us;
        const t = own ? at : at - lag;
        const h = c.frozen ? { d: 0, b: 0 } : head(own ? at * 1.31 + 5 : at, avatarMove);
        renderFace(pix, {
          mouth: c.frozen ? 0 : clamp01(speechAt(t, src) * avatarAmp),
          drift: h.d, bob: h.b,
          blink: c.frozen ? 0 : shut(own ? at * 0.87 + 2 : at - lag, bs),
          light: 0,
        });
      }
      grain(pix, i);
    }
    const motion = bandMotion(pix, i === 0 ? null : prev, AVATAR_BAND);
    prev.set(pix);

    est.push({ motion, voice, picture: shown, at });
    if (lockAt < 0 && est.measured) lockAt = at;
    onTick?.(est, at);
  }
  return { est, lockAt };
}
