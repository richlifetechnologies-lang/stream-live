// The one measurement the lip-sync timing is built on: how much a small picture of a face changed
// between two samples. It is deliberately here rather than in the streaming page, because the
// figures the timing works on have to come from real pixels - a rule proved against invented
// numbers is a rule that has not been proved.
//
// The avatar's picture is shrunk to a small frame and reduced to a single number: the mean change
// across a band. The band, not the whole frame, because shoulders, background flicker and gesture
// all move at once and a wide band smears every movement into a match. What it is lined up against is
// his microphone, which needs no picture and no band at all.

export const FRAME_W = 80, FRAME_H = 45;

export interface Band { x0: number; x1: number; y0: number; y1: number }

/** The avatar's mouth and lower face: the engine paints the words here. */
export const AVATAR_BAND: Band = {
  x0: Math.round(FRAME_W * 0.25), x1: Math.round(FRAME_W * 0.80),
  y0: Math.round(FRAME_H * 0.12), y1: Math.round(FRAME_H * 0.72),
};

/**
 * Mean absolute change of every channel across the band, 0..1, between two frames of the same
 * picture. Null on the first frame of a picture: there is nothing to compare it with, and a
 * comparison against an empty frame is the largest movement the call will ever see.
 */
export function bandMotion(
  frame: Uint8ClampedArray, prev: Uint8ClampedArray | null, band: Band,
): number {
  if (!prev) return 0;
  let sum = 0, n = 0;
  for (let y = band.y0; y < band.y1; y++) {
    for (let x = band.x0; x < band.x1; x++) {
      const i = (y * FRAME_W + x) * 4;
      sum += Math.abs(frame[i] - prev[i])
           + Math.abs(frame[i + 1] - prev[i + 1])
           + Math.abs(frame[i + 2] - prev[i + 2]);
      n++;
    }
  }
  return n ? sum / (n * 3 * 255) : 0;
}
