// How long the cable holds your voice back, so callers hear a word at the moment the avatar's mouth
// makes it rather than before it.
//
// The picture is late by however long the engine takes to render, and that figure is different for
// every style, every machine and every minute of the day. It has to be measured on the call.
//
// It is measured by asking the avatar's picture WHEN it answers him. His microphone gives a series of
// how loud he is - word by word, syllable by syllable - and the avatar's picture gives a series of how
// much its mouth is moving. Slide one against the other and the slide that lines them up IS the
// engine's delay. Nothing has to stop for a moment, no word needs a clean start, no frame needs to be
// still, and it keeps working while the avatar breathes, blinks and gestures, because all of that is
// beside the point: what is being matched is his voice arriving in his avatar's mouth.
//
// It is not measured off his own webcam, although that was the first plan. Two reasons, both from
// replaying calls against real rendered pictures. His webcam and his microphone are not two
// independent witnesses - they are the same words seen and heard - so a figure that matches his face
// also matches his voice, and requiring the two to agree proves nothing. And a lean, a shrug and an
// auto-gain drift are movements an engine does NOT reproduce on time, because it animates the mouth
// from the voice and lets a head wander; on the replayed calls that sway was enough to make an avatar
// answering nobody look exactly like an engine 2.4 s late (0.42 against 0.41 for a genuine one). The
// voice has no such false copy, and every engine speed that was timed correctly was timed correctly
// off it: 0.9, 1.8, 3.0 and 4.4 s within 0.15 s, a picture that keeps up at nothing, an engine that
// slows down mid-call followed to the new figure.
//
// What makes each figure trustworthy is not a threshold someone set at a desk. Every half second of
// the call votes for the delay it likes best, and the app only believes it when ONE vote keeps winning
// over the last thirty seconds. A moving background, a still avatar or one lucky window spreads its
// votes over several figures and none of them holds.
// And because a pool of votes is a memory, a figure has to be showing in the last twenty seconds of
// windows before the app COMMITS it: each half second is re-compared at whatever the call is leaning to,
// and unless that reading averages something, the answer belonged to a stretch of the call that is now
// gone and is never committed. Without that second witness an avatar animating off a rhythm of its own
// invented a figure in four conversations of eight. With it, and with the figure then kept (below), the
// second witness decides the commit only: re-measured after that change, seven of eight of those
// conversations and eight of eight of the ones whose picture is later than the cable can ever hold do
// still commit once, and now stand by it. The calls with nothing to correlate at all - no picture, a
// frozen picture, nobody speaking - commit in none of the eight, and hold nothing.
//
// Once a figure IS committed it is kept for the rest of that call, until the video stops. That is the
// owner's decision, taken on 2026-10-29 after his own machine was watched through a real call, and it is
// the right one for the calls that work: the cable's hold going back to nothing slides every caller's voice forward by the whole figure in
// the middle of a sentence, which is a worse fault than a figure that has stopped being re-confirmed. The
// twenty-second witness goes quiet for ordinary reasons - a long gap in his speech, a stretch of quiet, a
// picture that briefly stops repainting - and none of those means the engine changed. What still moves the
// number is a new figure the votes agree on: an engine that slows down mid-call is followed to the new
// figure, because the pool decides and a stale commit does not block it. The cost was measured after the
// change, over eight conversations of each class, and it is not small: an avatar animating off a rhythm of
// its own lines up a figure in SEVEN conversations of eight and a picture later than the cable can reach in
// EIGHT of eight, and every one of those now stands for the rest of the call instead of expiring. What each
// of those calls would have got otherwise is the voice running early for the second half of it, so the two
// failures are "a couple of seconds late on a call that was never lined up" and "a jump back to nothing in
// the middle of a sentence", and he picked the first. The three classes with genuinely nothing to correlate
// - no picture, a frozen picture, nobody speaking - still commit in none of the eight, because there is no
// figure for them to keep.
//
// Both series are stripped of everything slower than a couple of seconds before being compared, over
// the exact stretch being measured. A slow drift is not timing information. The removal is done as the
// window is read rather than with a filter that keeps state, because a filter warming up from zero
// hands BOTH series the same start-up ramp, and a silent room then votes for a delay of nothing - the
// one wrong answer that puts his voice in front of the avatar's mouth while the card says synced.
//
// The limit, stated plainly and measured rather than assumed. Two calls cannot be told from a good one by
// anything in the pictures: an engine that animates the mouth from somebody else's audio - a recorded
// loop, a television in the room - can be lined up with his voice by luck, and an engine LATER than the
// ceiling can be lined up a whole turn early, because his speech has gaps and so does the picture's. Both
// give a figure that is wrong but consistent, and the twenty-second witness above catches most of them but
// not all: counted over eight conversations of each, an avatar on a rhythm of its own still ends two of
// eight on a figure it made up, and a picture later than the cable can reach three of eight, the longest
// stretch run on one being forty-three seconds. Pushing that line harder was measured, not guessed - at
// 0.30, 0.35 and 0.40 instead, and read from a single window instead of twenty seconds - and each tightening
// bought about one conversation of coincidence and cost two or three real engines the figure they had found
// correctly. The first of these calls is a broken call rather than a mistimed one and the second is a cable
// that cannot help whoever is on it; in both the worst outcome is a voice a couple of seconds early on a
// call that was never going to line up. No timing rule fixes either, and pretending otherwise would be the
// same mistake as the standing guess this release removed.
//
// The other limit is a picture that repaints slowly, and it is stated as it was measured. A smooth picture
// is timed by about twenty seconds of the call; one repainted ten to twelve times a second by forty-five;
// then the votes thin out. Eight repaints a second: found in two calls out of two, at about a minute, and
// given up again before the end (before the figure was made to last the call, which is how it now is).
// Six and five: one call in two each, at a minute and a half. Four: one in
// three. Three: none in three. What those calls get is nothing held, which is his voice level with his
// avatar - the same outcome as a call with nothing wrong with it. Two ways to close the gap were tried
// and both cost more than they bought, and they are recorded on the numbers themselves rather than left
// for someone to rediscover.
//
// And when it cannot find a figure - no picture, an avatar that is not moving at all, a call nobody has
// spoken on yet - it holds NOTHING. Every earlier version held a standing guess of 0.8 s while it
// waited to measure, and a picture that keeps up with the voice then ran 0.8 s behind its own sound for
// the rest of the call. That guess is gone: an unmeasured call runs the voice level with the picture,
// which is what the customer hears when nothing is wrong.
//
// It lives apart from the streaming page because this is arithmetic over a sequence of samples, and a
// sequence can be replayed offline. Proving a timing rule against a real call costs a customer a minute
// and proves one number; replaying it proves the rule.

/** The slowest picture this will look for, and the most the cable will ever hold your voice back. */
export const MAX_HOLD = 5.0;
/** What the cable holds while it has no figure of its own: nothing. */
export const FALLBACK_HOLD = 0;

// The two series are reduced to one figure every 50 ms of real time. Bins are addressed by the clock
// rather than by a tick count, because a window sitting in the background ticks slowly and a slow timer
// must never be read as a slow engine.
const BIN_SEC = 0.05;
const WINDOW_BINS = 480;   // twenty-four seconds of both series
const PASS_BINS = 10;      // ...re-compared twice a second, for the whole call
const MAX_LAG_BINS = Math.round(MAX_HOLD / BIN_SEC);
const CARRY_BINS = 20;     // a reading is only trusted for one second of clock
// Nothing is believed until this much of the call has been watched, and every candidate slide has to be
// supported by at least this much of a comparison. The window is long on purpose: a person talking on a
// steady rhythm can be lined up with his own avatar a whole turn early or late, and only a long run of
// irregular speech - real speech - makes the engine's actual delay the one figure that keeps winning.
const MIN_WATCHED_BINS = 280;  // 14 s
const MIN_PAIRS = 120;         // 6 s lined up at that delay
// How fast a figure is averaged. One 50 ms sample of a microphone or a face is mostly noise; what
// carries across the two series is how busy that one has been over the last few samples.
const ENV_TAU = 0.25;
// Everything slower than this comes out of both series before they are compared. Syllables and words
// are the evidence; a slow drift is not, and left in it produces a peak as sharp as a real one.
const DETREND_SEC = 2.5;
// The match one half second gets to vote on. Low on purpose: one comparison is a weak witness, so its
// only job is to say "this delay, or nothing" and let the run of votes decide. Measured on the replayed
// calls, real engines vote between 0.39 and 0.60; the calls with no answer in them at all - nobody
// speaking, an avatar animating off somebody else's voice, a picture slower than the cable can ever
// hold - sit between 0.11 and 0.31.
// Dropping this to 0.30 was tried and measured: a picture repainted only three or four times a second
// then gathers more of its votes on the RIGHT figure, but so do the calls with no copy in them - one of
// them locks 4.30 s on a cable that should have held nothing - and a call that talks without stopping
// loses a figure it had correctly. The bar stays where the refusals need it, and a slow-repainting
// engine is reported as a gap instead.
const VOTE_R_MIN = 0.35;
// ...and a peak that lands on the last candidate slide has nowhere to fall back to - beyond the ceiling
// the cable cannot help whoever is on it anyway - so it has to match much better than an interior peak
// before the app claims a figure at all.
const EDGE_CORR_MIN = 0.60;
// Speech is regular enough that the avatar can sometimes be lined up with him a whole turn early or
// late and look almost as good. Of the slides matching within this much of the best one, the app takes
// the SHORTEST, because that is the one that cannot put the voice behind a mouth already moved.
const ALIAS_SLACK = 0.04;
// ...but only for a comparison that matches well in the first place. On a weak window the curve is
// broad, and an early slide is always within a hair of the best one by accident: taking it there would
// shorten the figure every time, which is the direction that puts the voice in front of the mouth.
// Measured on the replayed calls, this floor is what keeps a 4.4 s engine at 4.4 rather than three
// quarters of a second short of it.
const ALIAS_MIN = 0.45;
// Only a floor on "is this series alive at all" - a frozen picture, a microphone nobody has spoken
// into. These are not the figures that decide anything; they stop the app claiming a delay from a
// comparison of two flat lines.
const MIN_REMOTE_SD = 0.0002;
const MIN_VOICE_SD = 0.002;
// A picture that has just appeared is not a copy of anything: the engine's own arrival is the largest
// movement in the whole call, and crediting it is how one number, taken once, could sit wrong on the
// cable for the rest of it.
const SETTLE_SEC = 1.2;
// A figure this small is the avatar keeping up with his voice rather than following it. The card says
// so, and the cable holds nothing.
const LIVE_LAG = 0.075;
// Thirty seconds of votes. Long enough that a coincidence expires out of the back of the pool while its
// single lucky pass is still remembered up front, and short enough that a line which slows down
// mid-call takes over its own figure inside half a minute. A minute was tried for the calls whose votes
// come in slowly, and it is a bad trade: it fixes one of them and costs two real engines the figure they
// had correctly found, because the memory of a coincidence now lasts as long as the memory of an answer.
const VOTE_POOL_SEC = 30;
// Two votes this close in seconds are the same answer, not two different ones. Measured as a
// neighbourhood around each figure rather than a chain, because a run of votes drifting slowly across a
// second must not be counted as unanimous about any of it.
const CLUSTER_RADIUS = 0.3;
const MIN_CLUSTER_VOTES = 10;   // at least this many half-seconds have to give a damn about it...
// A floor on how far across the window the winning votes are spread was tried here, and it is the wrong
// shape: a real figure's spread shrinks during the gaps in his speech and again the moment the stream
// drops out, and three calls that had been timed correctly lost the figure they had. What is left is the
// count, the majority and the lead - and the one place a spread does separate an answer from a
// coincidence, below.
// ...and one answer has to have the pool behind it almost outright. Measured on the replayed calls,
// every engine that was timed correctly gathered 91-100% of the votes in its neighbourhood. Raising this
// further was tried and bought nothing: the two calls with no copy in them at all reach 100% too, on a
// rhythm that only looks like an answer until enough of the call goes by, so a stricter majority delays
// them by seconds while making a real engine likelier to lose a figure it had correctly.
const MIN_CLUSTER_SHARE = 0.6;
const MIN_CLUSTER_LEAD = 1.6;   // ...and beat the next answer by this much, outright.
// When the pool is split between two answers rather than settled on one, the shorter of them is taken
// - but only as a near-tie, only if it has a real following of its own, and only if it matches just as
// well. That is the whole-turn alias above: an avatar that keeps up with his voice is also, a whole turn
// later, lined up with it, and if the app takes the later one it holds his voice behind a mouth that
// already moved. The shortest answer is the only one that cannot do that.
const ALIAS_TIE = 0.7;
const ALIAS_SHARE = 0.4;
// ...and when the leading figure is itself the shortest one on the table, a rival cannot make it wrong by
// being numerous, only make the pool less certain - so it is kept on a bare majority instead of the full
// one, provided its votes have been arriving across most of the window. Measured: the call where the man
// never stops for breath holds its correct figure on 26 votes spread over 24 of the last 30 seconds at
// share 0.51, while the avatar that answers nobody gets its 13 votes inside 6 seconds at share 0.59 and
// never adds to them. A lead of two over the rival also separated them, on these seeds, by one tenth -
// which is not a rule, that is a coin. The spread is the difference that is actually in the pictures.
const MIN_KEEP_SHARE = 0.5;
const MIN_KEEP_SPAN = 12;
// ...and an answer has to be in the windows being read NOW, not only remembered by the pool, before the
// app commits to it. Every half second the window just compared is re-read at whatever figure the call is
// leaning to, and the last twenty seconds of those readings are averaged. (Once committed, a figure is not
// taken back for a weak stretch - see the top of the file; this witness decides the commit, and a fresh
// figure the votes agree on still replaces it.) Measured over eight conversations of each class: the
// calls with no copy of him in them - an avatar on a rhythm of its own, a picture later than the cable can
// ever reach - average 0.00 to 0.23 there, because their luck was one window that has since gone out of
// the pool while the picture answers at no lag at all. Real engines average 0.36 to 0.51. This line is
// what keeps most made-up figures off the cable; re-measured over eight conversations of each class after
// the keep rule went in, it still lets seven of eight avatar-on-a-rhythm calls and eight of eight
// past-the-ceiling calls commit once - see the top of the file for what that costs. The calls with
// nothing to correlate at all are refused eight times out of eight.
// It is an average over twenty seconds rather than this window on its own, and that is the whole difference
// between a rule and a wobble. A real engine's present match falls under any single-window line for seconds
// at a time, because his speech has gaps: read from one window at 0.40, a 4.4 s engine lost the figure it
// had correctly found, a man speaking very quietly lost it, the call where he never stops for breath lost
// it in two conversations of eight, and a 3.0 s engine spent thirty seconds of the call sliding his voice
// forward for nothing. Raising this line to 0.30, 0.35 or 0.40 was measured too, on eight conversations of
// every class: each buys about one conversation of coincidence and costs two or three real engines, so it
// stays where the refusals and the engines both agree.
const KEEP_WINDOW_SEC = 20;
const KEEP_R = 0.25;
// Four seconds of those readings, so one window cannot commit a call by itself - and so a picture that
// has only just come back after dropping out is read again rather than believed from a single pass.
const KEEP_READS = 8;

/** Why the card has no figure to show, in the cases the customer can act on. */
export type SyncReason = "measured" | "picture" | "movement" | "waiting";

export interface LipSyncSample {
  /** Movement inside the avatar's mouth and lower face, 0..1. Only meaningful while `picture` is true. */
  motion: number;
  /** How loud he is, off the microphone and before any gate - his words as a series. */
  voice: number;
  /** The avatar's picture is on screen and being sampled. */
  picture: boolean;
  /** Seconds on a real clock. */
  at: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** One half second's answer: which slide it liked, how well it matched, and when it was said. */
interface Vote { at: number; lag: number; r: number }

/** One answer and the votes standing within a third of a second around it. */
interface Winner {
  median: number; count: number; share: number; lead: number; r: number; span: number;
}

/** Everything the last thirty seconds of votes add up to. */
interface Pool {
  win: Winner | null; runner: Winner | null; short: Winner | null;
  share: number; lead: number; age: number;
}

/** Standard deviation from running sums, so one pass over the window carries every figure. */
function dev(sum: number, sumSq: number, n: number): number {
  return n > 1 ? Math.sqrt(Math.max(0, sumSq / n - (sum / n) ** 2)) : 0;
}

/** The value at a percentile of a copy of `xs` - used to cap one wild sample. */
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

export class LipSyncEstimator {
  /** Seconds of voice the cable is holding back right now. */
  hold = FALLBACK_HOLD;
  /** Whether `hold` is a figure the app found on this call. */
  measured = false;
  /** The avatar keeps up with his voice, so there is nothing to hold back. */
  live = false;
  /** What it is doing when it has no figure, so the card can say that instead of one vague line. */
  reason: SyncReason = "waiting";

  private motion = new Float64Array(WINDOW_BINS);
  private voice = new Float64Array(WINDOW_BINS);
  // Which slice of the clock each slot holds; a slot whose number has moved on is empty.
  private slotBin = new Int32Array(WINDOW_BINS).fill(-1);
  private readR = new Float64Array(WINDOW_BINS);
  private readV = new Float64Array(WINDOW_BINS);
  private filled = new Uint8Array(WINDOW_BINS);
  private curve = new Float64Array(MAX_LAG_BINS + 1);
  private envR = 0;
  private envV = 0;
  private pre = new Float64Array(WINDOW_BINS + 1);
  private preN = new Int32Array(WINDOW_BINS + 1);
  private sub = new Float64Array(WINDOW_BINS);
  private lastAt: number | null = null;
  private pictureAt: number | null = null;
  private firstBin = -1;
  private lastPassBin = -1;
  /** The last thirty seconds of votes: which half second said what, and how well it matched. */
  private votes: Vote[] = [];
  /** The last twenty seconds of windows, and how well each answered at the figure the pool had. */
  private kept: { at: number; r: number }[] = [];

  reset(): void {
    this.hold = FALLBACK_HOLD;
    this.measured = false;
    this.live = false;
    this.reason = "waiting";
    this.slotBin.fill(-1);
    this.pictureAt = null;
    this.firstBin = -1;
    this.lastPassBin = -1;
    this.lastAt = null;
    this.votes = [];
    this.kept = [];
  }

  push(s: LipSyncSample): void {
    if (!s.picture) { this._lostPicture(); return; }
    if (this.pictureAt === null) this._foundPicture(s.at);
    const arrived = this.pictureAt ?? s.at;
    const dt = this.lastAt === null ? BIN_SEC : Math.min(0.5, Math.max(0.001, s.at - this.lastAt));
    this.lastAt = s.at;
    const a = 1 - Math.exp(-dt / ENV_TAU);
    this.envV += (Math.max(0, s.voice) - this.envV) * a;
    const bin = Math.round(s.at / BIN_SEC);
    if (s.at - arrived < SETTLE_SEC) {
      // Inside the settle window the avatar's arrival is still on screen. Follow his voice, and keep
      // the picture's series flat so nothing from that spike reaches a comparison.
      this.envR = 0;
      return;
    }
    this.envR += (Math.max(0, s.motion) - this.envR) * a;
    this._write(bin, this.envR, this.envV);
    if (bin - this.lastPassBin >= PASS_BINS) {
      this.lastPassBin = bin;
      this._measure(bin, s.at);
    }
  }

  // A picture that goes away - a reconnect, a tab left and come back to - empties the window it was
  // measured against. The figure already found stays: the engine has not changed, and dropping the hold
  // would slide the voice forward in the middle of a call.
  private _lostPicture(): void {
    this.pictureAt = null;
    this.firstBin = -1;
    this.lastAt = null;
    this.slotBin.fill(-1);
    if (!this.measured) this.reason = "picture";
  }

  private _foundPicture(at: number): void {
    this.pictureAt = at;
    this.firstBin = -1;
    this.slotBin.fill(-1);
    this.lastPassBin = -1;
    this.envR = 0;
    this.envV = 0;
    // The picture is HERE, it just has not been watched long enough yet. Saying "no picture" over a live
    // one is what a customer reads as a broken call: measured on his machine, the card said NO PICTURE for
    // the first 15 s of a call whose avatar was running at 15 pictures a second the whole way through.
    if (!this.measured) this.reason = "waiting";
  }

  private _write(bin: number, remote: number, voice: number): void {
    const slot = ((bin % WINDOW_BINS) + WINDOW_BINS) % WINDOW_BINS;
    this.slotBin[slot] = bin;
    this.motion[slot] = remote;
    this.voice[slot] = voice;
    if (this.firstBin < 0) this.firstBin = bin;
  }

  private _measure(hi: number, at: number): void {
    const lo = Math.max(this.firstBin, hi - WINDOW_BINS + 1);
    if (this.firstBin < 0 || hi - lo + 1 < MIN_WATCHED_BINS) {
      // A picture is on screen, there is just not enough of the call behind it yet.
      if (!this.measured) this.reason = "waiting";
      return;
    }
    const n = hi - lo + 1;
    // A sample is worth as much as the clock says it is: a window ticking slowly has its readings carried
    // across the bins they cover rather than thrown away.
    let seen = 0, lastBin = -1, lastR = 0, lastV = 0;
    for (let i = 0; i < n; i++) {
      const bin = lo + i;
      const slot = ((bin % WINDOW_BINS) + WINDOW_BINS) % WINDOW_BINS;
      if (this.slotBin[slot] === bin) { lastBin = bin; lastR = this.motion[slot]; lastV = this.voice[slot]; }
      if (lastBin < 0 || bin - lastBin > CARRY_BINS) { this.filled[i] = 0; continue; }
      this.filled[i] = 1;
      this.readR[i] = lastR;
      this.readV[i] = lastV;
      seen++;
    }
    if (seen < MIN_WATCHED_BINS) { if (!this.measured) this.reason = "waiting"; return; }

    // One enormous sample can carry a correlation by itself. Capping each series at its own
    // ninety-fifth percentile leaves the pattern of the movement and takes the outlier's vote away.
    const rawR: number[] = [], rawV: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!this.filled[i]) continue;
      rawR.push(this.readR[i]); rawV.push(this.readV[i]);
    }
    const capR = percentile(rawR, 0.95), capV = percentile(rawV, 0.95);
    for (let i = 0; i < n; i++) {
      if (!this.filled[i]) continue;
      this.readR[i] = Math.min(this.readR[i], capR);
      this.readV[i] = Math.min(this.readV[i], capV);
    }

    // What is left to line up is the part of each series that SPEAKS: the slow drift comes off both over
    // exactly the stretch being compared.
    this._detrend(n);
    const st = this._stats(n, 0, 0);
    const remoteSd = dev(st.sy, st.syy, st.n);
    const voiceSd = dev(st.sx, st.sxx, st.n);

    // This half second's vote: the delay it likes best, shortened if an earlier one matches within a hair
    // of it. A vote is deliberately cheap to give - most passes on a live call give one - because the
    // decision is made by the run of them below, not by any single pass.
    const best = this._scan(n);
    const atEdge = best.lag === MAX_LAG_BINS;
    const chosen = this._shortest(best, atEdge);
    const alive = remoteSd >= MIN_REMOTE_SD && voiceSd >= MIN_VOICE_SD;
    const worth = chosen >= 0 && st.n >= MIN_PAIRS
      && this.curve[chosen] >= (atEdge ? EDGE_CORR_MIN : VOTE_R_MIN) && alive;
    if (worth) this.votes.push({ at, lag: chosen * BIN_SEC, r: this.curve[chosen] });
    while (this.votes.length && at - this.votes[0].at > VOTE_POOL_SEC) this.votes.shift();

    // One answer, voted for again and again, is the engine's delay. Everything else - a busy background,
    // an avatar on its own rhythm, a window that got lucky once - spreads its votes across several
    // figures and is refused by the numbers below rather than by a guess. An answer that only looked
    // unanimous from one end of the window is never committed; one that WAS committed is not un-made,
    // because the cable going back to nothing mid-call is heard by everyone on it.
    const a = this._analyse(this.votes);
    const won = this._dominant(a);
    // What the window being read NOW says at the answer the pool has - recorded whatever the pool
    // believes, so the twenty-second average is built from every reading and not only the flattering ones.
    const nowR = a.win ? this._at(a.win.median) : 0;
    if (a.win) this.kept.push({ at, r: nowR });
    while (this.kept.length && at - this.kept[0].at > KEEP_WINDOW_SEC) this.kept.shift();
    const mean = this.kept.length
      ? this.kept.reduce((s, k) => s + k.r, 0) / this.kept.length : 0;
    // A figure at or under LIVE_LAG holds NOTHING back on the cable, so this check has no wrong hold to
    // prevent there - and insisting on it costs the one kind of call that needs no hold its own answer,
    // because a picture that keeps up with his voice lines up less sharply in a given twenty seconds than
    // one a whole word behind does. The card still has to be told, so it is measured, and live.
    const keeps = !!won && won.median <= LIVE_LAG;
    if (!won || (!keeps && (this.kept.length < KEEP_READS || mean < KEEP_R))) {
      // A figure this call has already committed is KEPT until the video stops. Going back to nothing in
      // the middle of a call slides every caller's voice forward by the whole figure, and the twenty-second
      // witness goes quiet for the plainest of reasons - a gap in his speech, a quiet stretch, a picture
      // that briefly stops repainting - which is not evidence that the engine changed. Measured on his own
      // machine: a figure committed 17 s after it appeared and never re-found in the 50 s left, so the
      // voice ran 0.75 s early for the rest of that call. A NEW figure still replaces the old one below,
      // so a line that genuinely slows down mid-call is followed rather than frozen.
      if (this.measured) { this.reason = "measured"; return; }
      this.reason = alive ? "waiting" : (remoteSd < MIN_REMOTE_SD ? "movement" : "waiting");
      return;
    }

    this.hold = Math.min(MAX_HOLD, Math.max(0, won.median));
    this.measured = true;
    this.live = this.hold <= LIVE_LAG;
    this.reason = "measured";
  }

  /**
   * How well the curve of the window just compared answers at a given figure. A figure is a third of a
   * second wide, not a line, so this is the best slide anywhere inside it - the alternative reads one bin
   * and mistakes the window answering half a tenth of a second elsewhere for not answering at all. That
   * is what cost a picture that keeps up with his voice, and one 4.9 s away from the ceiling, their figure.
   */
  private _at(lag: number): number {
    const centre = Math.round(lag / BIN_SEC);
    const rad = Math.round(CLUSTER_RADIUS / BIN_SEC);
    let best = 0;
    for (let i = Math.max(0, centre - rad); i <= Math.min(MAX_LAG_BINS, centre + rad); i++) {
      best = Math.max(best, this.curve[i]);
    }
    return best;
  }

  /**
   * Subtract, from each series, its own centred mean over this much of a call. Done as the window is
   * read rather than with a filter that keeps state, so a reconnect or a throttled timer cannot leave a
   * start-up ramp behind for the next comparison to mistake for an answer.
   */
  private _detrend(n: number): void {
    const half = Math.round(DETREND_SEC / 2 / BIN_SEC);
    for (const xs of [this.readV, this.readR]) {
      this.pre[0] = 0; this.preN[0] = 0;
      for (let i = 0; i < n; i++) {
        this.pre[i + 1] = this.pre[i] + (this.filled[i] ? xs[i] : 0);
        this.preN[i + 1] = this.preN[i] + (this.filled[i] ? 1 : 0);
      }
      for (let i = 0; i < n; i++) {
        if (!this.filled[i]) continue;
        const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
        const cnt = this.preN[hi + 1] - this.preN[lo];
        this.sub[i] = xs[i] - (cnt > 0 ? (this.pre[hi + 1] - this.pre[lo]) / cnt : 0);
      }
      for (let i = 0; i < n; i++) if (this.filled[i]) xs[i] = this.sub[i];
    }
  }

  /**
   * The shortest candidate slide that matches within ALIAS_SLACK of the best one - but only once the
   * comparison matches well enough for an early slide to be a real alternative rather than a broad
   * curve's accident. A peak on the last slide that does not match well is refused outright, because
   * beyond the ceiling the cable cannot help whoever is on it.
   */
  private _shortest(best: { lag: number; r: number }, atEdge: boolean): number {
    if (best.lag < 0) return -1;
    if (atEdge) return best.r >= EDGE_CORR_MIN ? best.lag : -1;
    const slack = Math.max(ALIAS_MIN, best.r - ALIAS_SLACK);
    for (let lag = 0; lag < best.lag; lag++) if (this.curve[lag] >= slack) return lag;
    return best.lag;
  }

  /**
   * The one figure this call has committed to, or nothing. A figure is as strong as the number of votes
   * standing within a third of a second around it, and the winner has to be big in absolute terms, a
   * majority of everything voted, and clearly ahead of everything else. Ties go to the shortest figure,
   * which is the one that cannot put the voice behind a mouth already moved.
   */
  private _dominant(a: Pool): Winner | null {
    const win = a.win;
    if (!win || win.count < MIN_CLUSTER_VOTES) return null;
    if (a.share >= MIN_CLUSTER_SHARE && a.lead >= MIN_CLUSTER_LEAD) return win;
    const short = a.short;
    if (!short) return null;
    // The leader is already the shortest of the answers on the table: keep it on a bare majority, but only
    // while its votes have kept arriving across the window rather than arriving once and stopping.
    if (short === win) return a.share >= MIN_KEEP_SHARE && win.span >= MIN_KEEP_SPAN ? win : null;
    // A shorter answer is a genuine contender: as many votes as the leader can spare to call it a tie, a
    // following of its own, and a match that is no worse. Then it is the one to take, because it is the
    // only figure that cannot put his voice behind a mouth that has already moved.
    if (short.count < win.count * ALIAS_TIE) return null;
    if (short.share < ALIAS_SHARE || short.r < win.r - ALIAS_SLACK) return null;
    return short;
  }

  /** Everything the last thirty seconds of votes add up to, before any of it is believed. */
  private _analyse(votes: Vote[]): Pool {
    const clusters = this._clusters(votes);
    const win = clusters.reduce<Winner | null>((b, c) => (b && b.count >= c.count ? b : c), null);
    const rest = win ? clusters.filter(c => Math.abs(c.median - win.median) > CLUSTER_RADIUS) : [];
    const runner = rest.reduce<Winner | null>((b, c) => (b && b.count >= c.count ? b : c), null);
    const age = votes.length ? votes[votes.length - 1].at - votes[0].at : 0;
    const share = win ? win.count / votes.length : 0;
    const lead = win ? (runner && runner.count > 0 ? win.count / runner.count : Infinity) : 0;
    // The shortest answer with a following of its own - the one a split pool is reduced to.
    let short: Winner | null = null;
    for (const c of clusters) {
      if (c.count < MIN_CLUSTER_VOTES) continue;
      if (!short || c.median < short.median) short = c;
    }
    return { win, runner, short, share, lead, age };
  }

  /** Every neighbourhood in the pool, walked shortest-first, so a tie is settled by the shorter figure. */
  private _clusters(votes: Vote[]): Winner[] {
    const out: Winner[] = [];
    for (const centre of votes.slice().sort((a, b) => a.lag - b.lag)) {
      if (out.some(c => Math.abs(c.median - centre.lag) <= CLUSTER_RADIUS)) continue;
      const near = votes.filter(v => Math.abs(v.lag - centre.lag) <= CLUSTER_RADIUS);
      out.push({
        median: median(near.map(v => v.lag)), count: near.length,
        share: near.length / votes.length, lead: 0, r: median(near.map(v => v.r)),
        span: Math.max(...near.map(v => v.at)) - Math.min(...near.map(v => v.at)),
      });
    }
    return out;
  }

  /** Every candidate slide from 0 to the ceiling: his voice against the avatar's mouth. */
  private _scan(to: number): { lag: number; r: number } {
    let bestLag = -1, bestR = 0;
    const maxLag = Math.min(MAX_LAG_BINS, to - 1);
    for (let lag = 0; lag <= maxLag; lag++) {
      const st = this._stats(to - lag, 0, lag);
      const r = st.n >= MIN_PAIRS ? this._corr(st) : 0;
      this.curve[lag] = r;
      if (r > bestR) { bestR = r; bestLag = lag; }
    }
    for (let lag = maxLag + 1; lag <= MAX_LAG_BINS; lag++) this.curve[lag] = 0;
    return { lag: bestLag, r: bestR };
  }

  /**
   * Running sums for one slide: his voice at i against the avatar's mouth at i + lag, so a positive lag
   * means the picture answering him late - which is the only thing the cable can do anything about.
   */
  private _stats(to: number, from: number, lag: number): {
    n: number; sx: number; sxx: number; sy: number; syy: number; sxy: number;
  } {
    let cnt = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = from; i < to; i++) {
      const j = i + lag;
      if (!this.filled[i] || !this.filled[j]) continue;
      const x = this.readV[i], y = this.readR[j];
      cnt++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    return { n: cnt, sx, sy, sxx, syy, sxy };
  }

  private _corr(st: { n: number; sx: number; sy: number; sxx: number; syy: number; sxy: number }): number {
    if (st.n < 2) return 0;
    const num = st.n * st.sxy - st.sx * st.sy;
    const den = Math.sqrt(Math.max(0, st.n * st.sxx - st.sx * st.sx) * Math.max(0, st.n * st.syy - st.sy * st.sy));
    return den > 0 ? num / den : 0;
  }
}
