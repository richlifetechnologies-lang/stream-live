// Judgements taken off the audio bytes themselves, not off what the level detector believes.
//
// Both were needed after a call was recorded from inside the app on 4 November 2026: five of
// the twenty-three pieces the app handed the voice service held no signal at all (peak 20-31
// counts on a 16-bit scale, against 1,900-13,400 for a real sentence), and the service answered
// each one with the same length of silence, which then played to the caller as a hole where his
// voice should have been. The same recording showed the cloned answers carrying up to 3.8 s of
// dead air in front of the words, which is what pushed the playback queue 5.2 s behind by the
// end of a ninety-second call.

// A 16-bit piece quieter than this held nothing a person said: it is 15 dB below the lowest
// real sentence in that recording and 12 dB above the empty-room pieces, so it cannot mistake
// a quiet microphone for an dead one.
export const PIECE_SILENT_PEAK = 128;

/** The loudest sample in the raw 16-bit mono piece, in 0..32767 counts. */
export function piecePeak(pcm: ArrayBuffer): number {
  const s = new Int16Array(pcm);
  let peak = 0;
  for (let i = 0; i < s.length; i++) {
    const v = s[i] < 0 ? -s[i] : s[i];
    if (v > peak) peak = v;
  }
  return peak;
}

/** True when the piece actually carries a signal worth paying for and worth putting on air. */
export function pieceHasSignal(pcm: ArrayBuffer): boolean {
  return piecePeak(pcm) >= PIECE_SILENT_PEAK;
}

// Cloned audio comes back at full level, so one absolute line works for every voice: 2% of
// full scale is 12-35 dB under the answers that recording measured.
export const ANSWER_SILENCE_LEVEL = 0.02;

/** The first sample a person actually said, from `from` onwards, or -1 for none yet. */
export function speechOnset(data: Float32Array, from: number): number {
  for (let i = Math.max(0, from); i < data.length; i++) {
    if ((data[i] < 0 ? -data[i] : data[i]) >= ANSWER_SILENCE_LEVEL) return i;
  }
  return -1;
}

// Silence going OUT is paid for twice: the service is given the whole length, and it answers in
// roughly the same length back, so a sentence recorded with a second of room before it and two
// after it comes back a second and a half longer than anything he said. Cutting it here is the
// cheapest saving in the call - fewer bytes, a shorter answer, and less dead air in the queue.

const PIECE_WINDOW = 320;          // 20 ms of the 16 kHz mono piece
const PIECE_WINDOW_FLOOR = 150;    // counts: below this a window is his room, not his voice
const PIECE_RELATIVE = 0.15;       // and one quieter than this share of the loudest window is silence
const PIECE_PAD_BEFORE = 0.08;     // generous at both ends: a soft consonant must never be the cut
const PIECE_PAD_AFTER = 0.20;

/**
 * The spoken span inside a raw 16-bit piece, in samples. Null means the piece holds nothing a
 * person said, which is the same refusal the peak guard already makes on different grounds.
 */
export function pieceTrim(pcm: ArrayBuffer): { from: number; to: number } | null {
  const s = new Int16Array(pcm);
  const windows = Math.floor(s.length / PIECE_WINDOW);
  if (windows < 2) return { from: 0, to: s.length };
  const rms = new Float64Array(windows);
  let max = 0;
  for (let w = 0; w < windows; w++) {
    let sum = 0;
    for (let i = 0; i < PIECE_WINDOW; i++) { const v = s[w * PIECE_WINDOW + i]; sum += v * v; }
    const r = Math.sqrt(sum / PIECE_WINDOW);
    rms[w] = r;
    if (r > max) max = r;
  }
  const threshold = Math.max(PIECE_WINDOW_FLOOR, max * PIECE_RELATIVE);
  let first = -1, last = -1;
  for (let w = 0; w < windows; w++) {
    if (rms[w] >= threshold) { if (first < 0) first = w; last = w; }
  }
  if (first < 0) return null;
  const from = Math.max(0, Math.floor(first * PIECE_WINDOW - PIECE_PAD_BEFORE * 16000));
  const to = Math.min(s.length, Math.ceil((last + 1) * PIECE_WINDOW + PIECE_PAD_AFTER * 16000));
  return to - from > PIECE_WINDOW ? { from, to } : null;
}
