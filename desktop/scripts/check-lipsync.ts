// Offline proof for the lip-sync timing: what the app learns about how late the avatar's
// mouth is, and what it refuses to believe. A call is replayed here as the sequence of
// samples the streaming page feeds it - his words starting, and the face answering each one
// a fixed moment later - so a wrong rule shows up as a red line instead of as a customer
// hearing a voice run ahead of a mouth.
//
// Run with:  esbuild --bundle --platform=node --format=cjs scripts/check-lipsync.ts
//            --outfile=..\\tmp-check-lipsync.cjs  &&  node ..\\tmp-check-lipsync.cjs
// Nothing here touches the gateway, the camera, the microphone or a minute of anyone's balance.
import { DEFAULT_HOLD, LipSyncEstimator } from "../src/lib/lipsync";

const fail: string[] = [];
const near = (label: string, got: number, want: number, tol: number) => {
  const ok = Math.abs(got - want) <= tol;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${got.toFixed(2)} want ${want.toFixed(2)} ±${tol}`);
  if (!ok) fail.push(label);
};
const is = (label: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${got} want ${want}`);
  if (!ok) fail.push(label);
};

/** Word start times, spaced by the word plus the pause after it. */
const turns = (first: number, count: number, gap: number, word = 0.4) =>
  Array.from({ length: count }, (_, i) => first + i * (word + gap));

/**
 * One call, replayed. `lag` is how late the picture really is; `wordStarts` is when he
 * speaks; the face moves for exactly the length of the word it is answering, `lag` later.
 */
function call(o: {
  lag: number; wordStarts: number[]; seconds: number; dt?: number; word?: number;
  pictureFrom?: number; pictureTo?: number; arrivalSpike?: number; idle?: number;
  mouth?: number; jitter?: number;
}) {
  const dt = o.dt ?? 0.06;
  const word = o.word ?? 0.4;
  const from = o.pictureFrom ?? 0;
  const to = o.pictureTo ?? 1e9;
  const idle = o.idle ?? 0.010;
  const mouth = o.mouth ?? 0.090;
  const est = new LipSyncEstimator();
  for (let i = 0; i * dt <= o.seconds; i++) {
    const at = i * dt;
    const heard = o.wordStarts.some(w => at >= w && at < w + word);
    const answered = o.wordStarts.some(w => at >= w + o.lag && at < w + o.lag + word);
    const picture = at >= from && at < to;
    const arriving = o.arrivalSpike !== undefined && at >= from && at < from + o.arrivalSpike;
    const noise = o.jitter ? (Math.sin(at * 977.3) * 0.5 + 0.5) * o.jitter : 0;
    est.push({
      talking: heard,
      motion: picture ? (arriving ? 0.5 : answered ? mouth + noise : idle + noise) : 0,
      picture,
      at,
    });
  }
  return est;
}

// ─── The figure it must land on ───────────────────────────────────────────────
// A turn of the conversation: he speaks, the avatar answers, he speaks again after it.
const quick = call({ lag: 0.9, wordStarts: turns(4, 14, 2.0), seconds: 45 });
is("an ordinary engine is timed", quick.measured, true);
near("...and lands on the real lag", quick.hold, 0.9, 0.07);

const slow = call({ lag: 2.4, wordStarts: turns(4, 10, 3.0), seconds: 45 });
is("a slow engine is timed", slow.measured, true);
near("...and lands on the real lag", slow.hold, 2.4, 0.07);

// This is the customer complaint. The old rule threw any answer slower than 3.5 seconds
// away and refused to hold the voice longer than that either, so a call this slow kept the
// standing 0.8 guess and his words ran ahead of the mouth for the whole call.
const verySlow = call({ lag: 4.6, wordStarts: turns(4, 8, 5.5), seconds: 60 });
is("a very slow engine is timed", verySlow.measured, true);
near("...and the voice is held to match it", verySlow.hold, 4.6, 0.07);

// Slower than the cable will ever hold: timed, then held at the ceiling rather than
// believed outright.
const beyond = call({ lag: 5.8, wordStarts: turns(4, 8, 7.0), seconds: 70 });
is("an engine past the ceiling is still timed", beyond.measured, true);
near("...and held at the most the cable will do", beyond.hold, 5.0, 0.001);

// ─── What it must refuse to believe ───────────────────────────────────────────
// No picture: there is nothing to answer a word, so there is no figure, and the card has to
// keep saying so instead of showing a guess as a measurement.
const dark = call({ lag: 2, wordStarts: turns(4, 30, 2.0), seconds: 70, pictureFrom: 1e9 });
is("no picture ever: never claims to have timed it", dark.measured, false);
near("...and holds the standing guess", dark.hold, DEFAULT_HOLD, 0);

// The engine's own arrival is the biggest movement in the call, and it is not an answer to
// anything. Words said before the picture exists have no answer to find either.
const lateStart = call({
  lag: 2.4, wordStarts: turns(3, 12, 3.0), seconds: 60, pictureFrom: 12, arrivalSpike: 0.3,
});
is("a call whose picture lands late is still timed", lateStart.measured, true);
near("...and not by the picture landing", lateStart.hold, 2.4, 0.07);

// A moving background with nobody talking is not an answer to anything.
const nobody = call({ lag: 2, wordStarts: [], seconds: 45, jitter: 0.02 });
is("a face that moves while nobody speaks is not timed", nobody.measured, false);
near("...and the guess is untouched", nobody.hold, DEFAULT_HOLD, 0);

// A word that rides in on top of the answer to the word before it cannot be told apart from
// that answer. Timing one puts the voice further ahead of the mouth than the guess was.
const rapid = call({ lag: 4.6, wordStarts: turns(4, 40, 0.5), seconds: 45 });
is("a word that interrupts the previous answer is not timed", rapid.measured, false);

// One answer is a fluke; the card only believes two.
const once = call({ lag: 2.0, wordStarts: [4], seconds: 30 });
is("a single answer is not yet believed", once.measured, false);
near("...but it is already used", once.hold, 2.0, 0.07);

// Slower or faster than any real engine: refused outright, not clamped into a figure.
const absurd = call({ lag: 9, wordStarts: turns(4, 8, 12.0), seconds: 120 });
is("an answer slower than anything believed is not timed", absurd.measured, false);
near("...and the guess stays put", absurd.hold, DEFAULT_HOLD, 0);
const twitch = call({ lag: 0.02, wordStarts: turns(4, 12, 2.0), seconds: 45 });
is("a movement in the same instant as the word is not an answer", twitch.measured, false);

// ─── It keeps working after the first figure ──────────────────────────────────
// A line that starts fast and goes slow: the held figure follows it instead of freezing on
// whatever the opening of the call happened to show.
const drifting = new LipSyncEstimator();
{
  const dt = 0.06, word = 0.4;
  const starts = turns(4, 18, 4.0);
  for (let i = 0; i * dt <= 90; i++) {
    const at = i * dt;
    const heard = starts.some(w => at >= w && at < w + word);
    // The first half of the call answers in 1.5 s, the second half in 3.2 s - and the pause
    // between his turns is long enough for the slower answer to finish before he speaks.
    const lag = at < 45 ? 1.5 : 3.2;
    const answered = starts.some(w => at >= w + lag && at < w + lag + word);
    drifting.push({ talking: heard, motion: answered ? 0.09 : 0.01, picture: true, at });
  }
}
is("a line that slows down is still measured at the end", drifting.measured, true);
near("...and follows it", drifting.hold, 3.2, 0.25);

// A window sitting in the background ticks slowly. That is a slow timer, not a slow engine,
// so the figure must not inflate with it.
const throttled = call({ lag: 2.0, wordStarts: turns(8, 14, 3.0), seconds: 60, dt: 0.5, word: 0.8 });
is("a throttled timer still times the call", throttled.measured, true);
near("...and does not read it as a slower engine", throttled.hold, 2.0, 0.6);

console.log(fail.length ? `FAILED: ${fail.join(", ")}` : "all lip-sync rules pass");
