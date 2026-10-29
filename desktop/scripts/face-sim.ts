// A small face, painted into the same 80x45 frame the app samples, for the offline checks only.
// The point is that the timing is proved against pixel differences the sampling code really
// produces - not against invented movement figures, which is how a rule can pass a check and still
// strand a live call.
import { FRAME_W, FRAME_H } from "../src/lib/face-motion";

export interface FaceState {
  /** 0 = closed, 1 = as open as this face gets. */
  mouth: number;
  /** -1..1: head position left/right. */
  drift: number;
  /** -1..1: head position up/down. */
  bob: number;
  /** 0 open .. 1 shut. */
  blink: number;
  /** -1..1: exposure, the thing a webcam's auto-gain does to every pixel at once. */
  light: number;
}

/** One face into a byte array the size of the sampled frame. */
export function renderFace(px: Uint8ClampedArray, s: FaceState): void {
  const cx = FRAME_W / 2 + s.drift * 4;
  const cy = FRAME_H * 0.44 + s.bob * 2;
  const rx = 13, ry = 16;
  const lift = Math.round(s.light * 22);
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      const i = (y * FRAME_W + x) * 4;
      // Room: a soft gradient, so a head that moves is not the only thing that can change.
      let r = 44 + (y * 2), g = 50 + y, b = 66 + y;
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) { r = 196; g = 158; b = 132; }
      px[i] = clamp(r + lift); px[i + 1] = clamp(g + lift); px[i + 2] = clamp(b + lift); px[i + 3] = 255;
    }
  }
  // Eyes: shut for a blink, so an idle face still moves without anybody talking.
  const eh = Math.max(0.4, (1 - s.blink) * 2.2);
  box(px, cx - 5.5, cy - 4, 3.2, eh, 30, 24, 24);
  box(px, cx + 2.3, cy - 4, 3.2, eh, 30, 24, 24);
  // Mouth: the only thing that moves while he speaks.
  const mh = 1 + s.mouth * 6.5;
  box(px, cx - 5, cy + 7.5, 10, mh, 92, 44, 46);
  if (s.mouth > 0.35) box(px, cx - 3.4, cy + 8.2, 6.8, (s.mouth - 0.35) * 4.5, 24, 14, 16);
}

function box(
  px: Uint8ClampedArray, x0: number, y0: number, w: number, h: number, r: number, g: number, b: number,
): void {
  for (let y = Math.round(y0); y < Math.round(y0 + h); y++) {
    for (let x = Math.round(x0); x < Math.round(x0 + w); x++) {
      if (x < 0 || y < 0 || x >= FRAME_W || y >= FRAME_H) continue;
      const i = (y * FRAME_W + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
}

const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

export const newFrame = (): Uint8ClampedArray => new Uint8ClampedArray(FRAME_W * FRAME_H * 4);

/**
 * The shape of a turn of speech: a word is as long and as loud as the person made it, and inside
 * it the voice rises and falls on every syllable. Nobody talks on a metronome, and that is what
 * makes the engine's real delay findable - a steady rhythm can be matched a whole turn early or
 * late and look exactly as good.
 */
export interface Utterance { at: number; len: number; amp: number }

export function speechAt(t: number, us: Utterance[]): number {
  let v = 0;
  for (const u of us) {
    if (t < u.at || t >= u.at + u.len) continue;
    const inside = (t - u.at) / u.len;
    const syllables = 0.55 + 0.45 * Math.abs(Math.sin(2 * Math.PI * 3.4 * (t - u.at)));
    v = Math.max(v, u.amp * Math.min(1, Math.sin(Math.PI * inside) * syllables + 0.15));
  }
  return v;
}

/** A deterministic stand: the same conversation on every run, so a check that passes cannot be luck. */
export function conversation(seconds: number, seed: number, talkFraction = 0.4, first = 3): Utterance[] {
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out: Utterance[] = [];
  let t = first;
  while (t < seconds) {
    const len = 0.25 + rand() * 1.75;
    out.push({ at: t, len, amp: 0.45 + rand() * 0.55 });
    t += len + (0.15 + rand() * 3.4) * (1 / talkFraction - 0.4);
  }
  return out;
}
