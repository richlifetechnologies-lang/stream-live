// Offline proof for the lip-sync timing, driven through PIXELS.
//
// The calls are painted by the shared simulator in `face-call.ts`: the avatar's picture as a stream of
// real frames, reduced to movement by the app's own `bandMotion`, against his microphone as a stream of
// real levels. That is the point of this file. The last two releases passed checks written against
// invented movement figures, and a rule proved against numbers nobody measures is a rule that has not
// been proved.
//
// Nothing here stops a call, and nothing here pretends to. What is proved is which figure the app puts
// on the cable, how long it takes to get it, and what it does when there is no figure to get: hold
// nothing, say so, and let the customer talk.
//
// Run with:  esbuild --bundle --platform=node --format=cjs scripts/check-lipsync.ts
//            --outfile=..\\tmp-check-lipsync.cjs  &&  node ..\\tmp-check-lipsync.cjs
// Nothing here touches the gateway, the camera, the microphone or a minute of anyone's balance.
import { FALLBACK_HOLD, MAX_HOLD, type SyncReason } from "../src/lib/lipsync";
import { replay, type Call } from "./face-call";
import type { Utterance } from "./face-sim";

const fails: string[] = [];
const gaps: string[] = [];

/** A call whose engine speed must be found: the held figure within `tol` of the real lag, by `maxLock`. */
function timed(label: string, c: Call, want: number, tol: number, maxLock = 45): void {
  const { est, lockAt } = replay(c);
  const err = est.hold - want;
  const ok = est.measured && Math.abs(err) <= tol && lockAt >= 0 && lockAt <= maxLock;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}: real ${want.toFixed(2)}s -> held ${est.hold.toFixed(2)}s `
    + `(err ${err >= 0 ? "+" : ""}${err.toFixed(2)}, tol ±${tol}), found by `
    + `${lockAt < 0 ? "the end of the call" : `${lockAt.toFixed(1)}s (limit ${maxLock}s)`}`,
  );
  if (!ok) fails.push(label);
}

/** A picture that keeps up with the voice: the card must be able to say the voice is not held. */
function keepsUp(label: string, c: Call): void {
  const { est, lockAt } = replay(c);
  const ok = est.measured && est.live && est.hold <= 0.075;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}: held ${est.hold.toFixed(2)}s, says "no hold needed" by `
    + `${lockAt < 0 ? "the end of the call" : `${lockAt.toFixed(1)}s`}`,
  );
  if (!ok) fails.push(label);
}

/** A call with no delay in it to find: no figure, nothing held back, and a reason the card can show. */
function noFigure(label: string, c: Call, why?: SyncReason): void {
  const { est } = replay(c);
  const ok = !est.measured && est.hold === FALLBACK_HOLD && (!why || est.reason === why);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}: at the end of the call - figure ${est.measured}`
    + `, held ${est.hold.toFixed(2)}s, card says "${est.reason}"`
    + `${why ? `, want "${why}"` : ", want no figure and nothing held"}`,
  );
  if (!ok) fails.push(label);
}

/**
 * How long a call was run on a figure the app later gave up. Printed for the two calls the rule cannot
 * settle from the pictures alone: a wrong number that reaches a cable for thirty seconds is a fact about
 * the release, not a detail to leave out of the report.
 */
function longestClaim(label: string, c: Call): void {
  let from = -1, best = 0, bestAt = 0, bestHold = 0;
  const { est } = replay(c, (e, at) => {
    if (e.measured) {
      if (from < 0) from = at;
      if (at - from > best) { best = at - from; bestAt = from; bestHold = e.hold; }
    } else from = -1;
  });
  console.log(
    `      ${label}: ${best ? `claimed ${bestHold.toFixed(2)}s for ${best.toFixed(0)}s from ${bestAt.toFixed(0)}s` : "never claimed a figure"}`
    + `, ends held ${est.hold.toFixed(2)}s`,
  );
}

/**
 * A call this release can only fail to time, measured honestly. It is not a pass and it is not dressed
 * up as one: what must never happen is the app putting a WRONG figure on the cable. Nothing held is the
 * agreed failure mode - the customer talks with his voice level with the picture instead of late.
 */
function gap(label: string, c: Call, want: number, tol: number): void {
  const { est, lockAt } = replay(c);
  const err = est.hold - want;
  if (!est.measured) {
    gaps.push(label);
    console.log(
      `GAP   ${label}: real ${want.toFixed(2)}s -> held ${est.hold.toFixed(2)}s, card says "${est.reason}"`
      + `${lockAt >= 0 ? `, first found at ${lockAt.toFixed(1)}s and given up again before the end` : ", never found"}. Nothing is held - not a guess.`,
    );
    return;
  }
  const ok = Math.abs(err) <= tol;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}: real ${want.toFixed(2)}s -> held ${est.hold.toFixed(2)}s `
    + `(err ${err >= 0 ? "+" : ""}${err.toFixed(2)}), found by ${lockAt.toFixed(1)}s`,
  );
  if (!ok) fails.push(label);
}

// ─── The figure it must land on ───────────────────────────────────────────────
// Four engine speeds, two ways of talking, three conversations each. This is the whole release: the
// voice is held back by however late THIS call's picture turns out to be.
for (const lag of [0.9, 1.8, 3.0, 4.4]) {
  for (const talk of [0.4, 0.85]) {
    for (const seed of [1, 2, 3]) {
      timed(`engine ${lag.toFixed(1)}s, ${talk === 0.4 ? "with pauses" : "hardly stopping"}, conversation ${seed}`,
        { lag, talk, seed, seconds: 60 }, lag, 0.35);
    }
  }
}

// A man who never stops for breath, one word riding over the next. The old rule needed a pause to find a
// word's start and had none to work with.
timed("a caller who does not stop talking", { lag: 1.2, talk: 0.95, first: 2, seconds: 60 }, 1.2, 0.35);

// A face that is never still - an avatar swaying, gesturing and blinking the whole time it answers him.
timed("an avatar that never holds still", { lag: 2.4, seconds: 60, avatarMove: 0.9, seed: 4 }, 2.4, 0.4);

// An engine that repaints its mouth only a few times a second carries too little of his speech in each
// half-second comparison, so its votes arrive too seldom to make a run. Measured on ninety-second calls
// with the picture repainted at these rates - the number in brackets is how many of the conversations
// tested ended the call holding the right figure:
//   15, 12, 10 a second: all of them, found by 20-45s     8: none of two (found at ~57s, given up again)
//   6: one of two, at 87s   5: one of two, at 87s   4: one of three   3: none of three
// Lowering the match bar to let these through was tried and is a bad trade: at 0.30 a call with no copy
// in it locks 4.30 s onto a cable that should have held nothing, and a man who talks without stopping
// loses a figure he had correctly. Lengthening the memory of the votes to a minute was tried too: it
// bought one of these calls and cost two real engines their figure. So the bar stays, these are reported
// as gaps, and what they do is hold nothing - his voice level with his avatar, the same as a call with
// nothing wrong with it.
gap("a picture painted eight times a second", { lag: 2.2, seconds: 90, fps: 8, seed: 34 }, 2.2, 0.5);
gap("a picture painted eight times a second, other conversation", { lag: 2.8, seconds: 90, fps: 8, seed: 6 }, 2.8, 0.5);
gap("a picture painted 4 times a second", { lag: 2.8, seconds: 90, fps: 4, seed: 6 }, 2.8, 0.5);
gap("a picture painted 4 times a second, other conversations", { lag: 2.8, seconds: 90, fps: 4, seed: 31 }, 2.8, 0.5);
gap("a picture painted 4 times a second, another", { lag: 2.8, seconds: 90, fps: 4, seed: 32 }, 2.8, 0.5);
gap("a slow picture on a slow engine", { lag: 3.4, seconds: 90, fps: 3, seed: 23 }, 3.4, 0.6);
gap("a slow picture on a slow engine, other conversation", { lag: 3.4, seconds: 90, fps: 3, seed: 33 }, 3.4, 0.6);

// Where it starts working again, and how long it takes: a briskly repainted picture is timed, just not
// as fast as a smooth one.
timed("a picture painted ten times a second", { lag: 2.8, seconds: 90, fps: 10, seed: 6 }, 2.8, 0.5, 60);
timed("a picture painted twelve times a second", { lag: 2.8, seconds: 90, fps: 12, seed: 6 }, 2.8, 0.5, 60);

// An avatar that keeps up with his voice. There is no gap to hold the voice behind, and holding one is
// exactly the desync 1.8.16 and 1.8.17 put on the cable and left there for the whole call.
keepsUp("his own avatar keeps up", { lag: 0.04, seconds: 60, seed: 8 });

// The engine slows down nine minutes in: the figure has to follow it rather than freeze on whatever the
// opening of the call happened to show.
timed("an engine that goes slow mid-call",
  { lag: 1.4, lagFrom: { at: 30, lag: 3.2 }, seconds: 75, seed: 9 }, 3.2, 0.55, 75);

// The picture is not there at the start, and its arrival is the largest movement in the call.
timed("a picture that lands late is not timed by landing",
  { lag: 2.4, pictureFrom: 14, seconds: 75, seed: 10 }, 2.4, 0.45, 70);

// The stream drops out mid-call and comes back: what the call already learned is kept rather than slid
// forward, and the new stretch of the call re-checks it.
{
  const { est, lockAt } = replay({ lag: 2.0, seconds: 75, lose: { at: 40, seconds: 8 }, seed: 26 });
  const err = est.hold - 2.0;
  const ok = est.measured && lockAt > 0 && Math.abs(err) <= 0.5;
  console.log(
    `${ok ? "PASS" : "FAIL"}  a reconnect keeps its figure: found by ${lockAt.toFixed(1)}s, `
    + `after eight seconds of nothing held ${est.hold.toFixed(2)}s (real 2.00, err ${err >= 0 ? "+" : ""}${err.toFixed(2)})`,
  );
  if (!ok) fails.push("a reconnect keeps its figure");
}

// The slowest picture the cable can still serve, and the promise that it never holds more than the
// ceiling no matter what it thinks it found.
timed("the slowest picture the cable will still follow", { lag: MAX_HOLD - 0.1, seconds: 60, seed: 22 }, MAX_HOLD - 0.1, 0.45);
{
  const { est } = replay({ lag: 20, seconds: 60, seed: 27 });
  const ok = est.hold <= MAX_HOLD;
  console.log(`${ok ? "PASS" : "FAIL"}  the ceiling is never crossed: a picture 20s late held ${est.hold.toFixed(2)}s`);
  if (!ok) fails.push("the ceiling is never crossed");
}

// A man who barely speaks, and a call with almost nothing in it: both still carry a real delayed copy of
// his words, so the right answer is to time them - a soft-spoken customer is not a call to give up on.
timed("a man speaking very quietly",
  { lag: 2.0, seconds: 60, voiceAmp: 0.03, seed: 11 }, 2.0, 0.4);
timed("three words in a minute", {
  lag: 2.0, seconds: 60,
  us: [{ at: 20, len: 0.5, amp: 0.9 }, { at: 41, len: 0.4, amp: 0.7 }, { at: 55, len: 0.3, amp: 0.8 }] as Utterance[],
  seed: 15,
}, 2.0, 0.4, 60);

// ─── What it must have no figure for ──────────────────────────────────────────
// No avatar picture, ever - the stream never lands.
noFigure("no picture at all", { lag: 2.0, seconds: 60, pictureFrom: 1e9, seed: 13 }, "picture");

// A picture on screen that never moves - a stream that arrived and stalled.
noFigure("a picture that never moves", { lag: 2.0, seconds: 60, frozen: true, seed: 12 }, "movement");

// Nobody speaks: the room moves, faces blink, and none of it is a delayed copy of a word.
noFigure("a call nobody has talked on", { lag: 2.0, seconds: 60, talk: 0.001, first: 1e9, seed: 14 });

// Two calls the pictures genuinely cannot answer, because there is no copy of him in them: an avatar
// animating off somebody else's audio, and an engine later than the cable's ceiling. They end with
// nothing held; how long each one spent believing its coincidence is printed above, not hidden.
noFigure("an avatar answering nothing", { lag: 2.0, seconds: 70, ownRhythm: true, seed: 16 });
noFigure("a picture 5.8s late, past the ceiling", { lag: 5.8, seconds: 70, seed: 17 });
noFigure("a picture 9s late", { lag: 9, seconds: 90, talk: 0.6, seed: 18 });
longestClaim("  known limit: an avatar answering nothing", { lag: 2.0, seconds: 70, ownRhythm: true, seed: 16 });
longestClaim("  known limit: a picture 5.8s late", { lag: 5.8, seconds: 70, seed: 17 });

// ─── It keeps working after the first figure ──────────────────────────────────
// A long call keeps what it learned rather than drifting off it.
{
  const { est, lockAt } = replay({ lag: 1.6, seconds: 90, seed: 19 });
  const err = est.hold - 1.6;
  const ok = est.measured && Math.abs(err) <= 0.4 && lockAt > 0;
  console.log(`${ok ? "PASS" : "FAIL"}  a long call keeps its figure: held ${est.hold.toFixed(2)}s (real 1.60, err ${err >= 0 ? "+" : ""}${err.toFixed(2)}), found at ${lockAt.toFixed(1)}s`);
  if (!ok) fails.push("a long call keeps its figure");
}

// A new call starts clean: nothing carries over from the last one.
{
  const a = replay({ lag: 2.4, seconds: 60, seed: 20 });
  a.est.reset();
  const ok = !a.est.measured && a.est.hold === FALLBACK_HOLD && !a.est.live && a.est.reason === "waiting";
  console.log(`${ok ? "PASS" : "FAIL"}  a new call starts clean: held ${a.est.hold.toFixed(2)}s, card says "${a.est.reason}"`);
  if (!ok) fails.push("a new call starts clean");

  // ...and the opening of a call is not dressed up as a measurement, because that is where a standing
  // guess used to live.
  const opening = replay({ lag: 2.4, seconds: 6, seed: 21 });
  const ok2 = !opening.est.measured && opening.est.hold === FALLBACK_HOLD;
  console.log(`${ok2 ? "PASS" : "FAIL"}  the first seconds of a call hold nothing: held ${opening.est.hold.toFixed(2)}s, figure=${opening.est.measured}`);
  if (!ok2) fails.push("the opening of a call");
}

// ─── The same rules judged over eight conversations, not the one a check happened to pick ────────────
// Everything above runs one conversation per case, and that proved far too weak a witness for the calls
// that must get no figure: an avatar on a rhythm of its own ends the call holding a made-up figure in
// four conversations out of eight, and a picture later than the ceiling in three of eight, while every
// single-seed assertion above watched a conversation that happened not to. So each class is judged eight
// times over here, and both the figures found and the claims made are counted rather than sampled.
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

/** Eight conversations of an engine speed that has to be timed. */
function timedSeeds(label: string, make: (seed: number) => Call, want: number, tol: number, maxLock: number): void {
  const runs = SEEDS.map(seed => replay(make(seed)));
  const wrong = runs.filter(r => r.est.measured && Math.abs(r.est.hold - want) > tol);
  const slow = runs.filter(r => r.est.measured && !(r.lockAt >= 0 && r.lockAt <= maxLock));
  const none = runs.filter(r => !r.est.measured);
  const worst = Math.max(...runs.map(r => Math.abs(r.est.hold - want)));
  const latest = Math.max(...runs.map(r => r.lockAt));
  console.log(
    `${wrong.length || slow.length ? "FAIL" : "PASS"}  ${label}: eight conversations, `
    + `${runs.length - wrong.length - slow.length - none.length}/8 timed within ±${tol}s by ${maxLock}s `
    + `(worst error ${worst.toFixed(2)}s, latest found ${latest.toFixed(0)}s)`
    + `${none.length ? `, ${none.length} given up - nothing held, not a guess` : ""}`
    + `${wrong.length ? `, ${wrong.length} WRONG figure held` : ""}`,
  );
  if (wrong.length) fails.push(`${label} (${wrong.length} wrong figures)`);
  if (slow.length) fails.push(`${label} (${slow.length} too slow to find)`);
  if (none.length) gaps.push(`${label} (${none.length} of 8 conversations)`);
}

/** Eight conversations of a call that has no copy of him in it, and so must end holding nothing. */
function refusedSeeds(label: string, make: (seed: number) => Call, maxHeld: number): void {
  let longest = 0;
  const held = SEEDS.map(seed => {
    let from = -1, best = 0;
    const { est } = replay(make(seed), (e, at) => {
      if (!e.measured) { from = -1; return; }
      if (from < 0) from = at;
      best = Math.max(best, at - from);
    });
    longest = Math.max(longest, best);
    return est.measured;
  }).filter(Boolean).length;
  console.log(
    `${held > maxHeld ? "FAIL" : "PASS"}  ${label}: eight conversations, ${held}/8 end holding a figure `
    + `(limit ${maxHeld}), longest one run on it ${longest.toFixed(0)}s`,
  );
  if (held > maxHeld) fails.push(`${label} (${held} of 8 held a figure)`);
}

for (const lag of [0.9, 1.8, 3.0, 4.4]) {
  timedSeeds(`engine ${lag.toFixed(1)}s, eight conversations`, seed => ({ lag, seconds: 90, seed }), lag, 0.35, 45);
}
refusedSeeds("an avatar on a rhythm of its own", seed => ({ lag: 2.0, seconds: 90, ownRhythm: true, seed }), 3);
refusedSeeds("a picture 5.8s late, past the ceiling", seed => ({ lag: 5.8, seconds: 90, seed }), 3);
refusedSeeds("a picture 7s late", seed => ({ lag: 7, seconds: 90, talk: 0.6, seed }), 3);
refusedSeeds("a picture 20s late", seed => ({ lag: 20, seconds: 90, seed }), 3);
refusedSeeds("no picture at all", seed => ({ lag: 2.0, seconds: 90, pictureFrom: 1e9, seed }), 0);
refusedSeeds("a picture that never moves", seed => ({ lag: 2.0, seconds: 90, frozen: true, seed }), 0);
refusedSeeds("a call nobody has talked on", seed => ({ lag: 2.0, seconds: 90, talk: 0.001, first: 1e9, seed }), 0);

console.log(
  fails.length
    ? `FAILED (${fails.length}): ${fails.join(" | ")}`
    : `all lip-sync rules pass, from the pixels up`
    + `${gaps.length ? ` - with ${gaps.length} reported gap${gaps.length === 1 ? "" : "s"}: ${gaps.join(" | ")}` : ""}`,
);
if (fails.length) process.exit(1);
