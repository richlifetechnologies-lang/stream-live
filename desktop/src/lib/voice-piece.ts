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
const ANSWER_SILENCE_LEVEL = 0.02;
const ANSWER_KEEP_HEAD_S = 0.06;   // a short breath before the first word, so nothing clips
const ANSWER_KEEP_TAIL_S = 0.12;   // and a short one after, so the last consonant survives

/**
 * Where the spoken part of a cloned answer actually starts and how long it runs, so only that
 * is played. Null means the answer holds no speech at all - it is not the cloned voice, and it
 * must never reach the cable, the readout or the money clock.
 */
export function answerTrim(data: Float32Array, sampleRate: number, duration: number):
  { head: number; kept: number } | null {
  let first = -1, last = -1;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] < 0 ? -data[i] : data[i];
    if (v >= ANSWER_SILENCE_LEVEL) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) return null;
  const head = Math.max(0, first / sampleRate - ANSWER_KEEP_HEAD_S);
  const tailAt = Math.min(duration, last / sampleRate + ANSWER_KEEP_TAIL_S);
  const kept = tailAt - head;
  return kept > 0.05 ? { head, kept } : null;
}
