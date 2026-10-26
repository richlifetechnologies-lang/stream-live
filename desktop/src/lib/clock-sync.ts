// A customer's own clock can stop his call before it is ever asked for.
//
// The call pass the gateway hands the app carries an expiry time. The video software
// compares that time with the clock on the machine and refuses to dial at all when it
// reads the pass as already spent — so a computer running hours ahead throws away a pass
// that is minutes old, and the screen reports it as a dead video line. Nothing read off
// that machine can tell the two apart: the pass is fine, the answer is fine, only the
// clock disagrees with everyone else's. So the time comes from the gateway's answer.
//
// Making the pass itself longer was measured and is not the fix: a day is further ahead than
// the longest pass there is, so a machine that wrong would keep failing while every honest
// machine paid for the extra hour a stolen pass would live.
//
// Only Date.now is corrected: the refusal this cures reads its time from Date.now, and a
// number that changed halfway through a call would rewind the timers that decide when a
// call is dead. So it is measured twice and never mid-call — once when the app opens, before
// this machine has decided anything about a pass or a login ticket, and again as each call is
// booked, before any dial.

/** Below one minute the pass still outlives the dial, so a skew this small breaks nothing. */
export const CLOCK_NOTICE_MS = 60_000;

/** The machine's own reading, kept so the number written down stays the machine's error. */
const localNow = Date.now.bind(Date);

let skewMs: number | null = null;

/**
 * Take the gateway's clock as the app's own, if this machine is far enough off to matter.
 * `serverTimeMs` is the time stamped on a gateway answer — the one the app reads when it
 * opens, and the one each call is booked with. Null means a gateway that has not been
 * updated yet, or one that would not answer, and leaves the machine's clock alone.
 *
 * Returns how far the machine ran off real time in milliseconds — positive when it is
 * ahead — or null when nothing has ever been measured.
 */
export function alignClock(serverTimeMs: number | null): number | null {
  if (typeof serverTimeMs !== "number" || !Number.isFinite(serverTimeMs) || serverTimeMs <= 0) return skewMs;
  const off = localNow() - serverTimeMs;
  skewMs = off;
  // Subtract, never add: the machine is the thing that is wrong, so its own reading minus
  // its own error is real time. `localNow` is the clock as this module found it, so a
  // re-measure on the next press cannot compound — and a machine whose clock has since been
  // fixed is followed back to its own reading instead of staying corrected.
  Date.now = Math.abs(off) < CLOCK_NOTICE_MS ? localNow : () => localNow() - off;
  return off;
}

/** How far this machine's clock ran off the gateway's, or null until the gateway has answered. */
export function clockSkewMs(): number | null {
  return skewMs;
}

const UNITS: Array<[string, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
];

/** The same number the way a person says it: "1 day ahead of", "9 minutes behind". */
export function describeClockSkew(ms: number): string {
  const side = ms > 0 ? "ahead of" : "behind";
  for (const [name, size] of UNITS) {
    if (Math.abs(ms) >= size) {
      const n = Math.round(Math.abs(ms) / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ${side}`;
    }
  }
  return "less than a second off";
}
