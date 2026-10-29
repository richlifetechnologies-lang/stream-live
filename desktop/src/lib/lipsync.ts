// How long the cable holds your voice back, so callers hear a word at the moment the
// avatar's mouth makes it rather than before it.
//
// The picture is usually late: the engine renders the mouth some time AFTER it receives the
// word. Nothing here is a setting - the app times that gap on the call itself, by watching when
// his voice starts and when the face answers it, and holds the outgoing copy of his voice by the
// figure it lands on.
//
// Some avatars are not late at all: the mouth on screen moves with the person speaking, within a
// single sample. There is no gap to time in that, and holding the voice by the standing guess
// would put the sound behind a picture that already keeps up - which looks and sounds like the
// audio moving slow. That case is detected from what it does to the same measurements, and the
// cable then holds nothing.
//
// It lives apart from the streaming page for one reason: this is arithmetic over a sequence
// of samples, and a sequence can be replayed offline. Proving a timing rule against a real
// call costs a customer a minute and proves one number; replaying it proves the rule.

const MIN_LAG  = 0.12;   // below this it is the same mouth moving, not a separate answer
const MAX_LAG  = 6.0;    // the slowest picture answer this will still believe
const MIN_HOLD = 0.1;    // ...and the least a timed answer will ever hold the voice back
/** The most the cable will ever hold your voice back. */
export const MAX_HOLD = 5.0;
/** What it holds before it has timed anything. */
export const DEFAULT_HOLD = 0.8;

// How long the picture has to have been watched before a mouth that never lags a word is
// called live, and how many of those same-instant movements it has to have seen to say so. One
// flicker is not a pattern; two words the picture answered inside a sample, over half a minute of
// call, is.
const NEAR_LIVE_SEC = 25;
const LIVE_MOVES    = 2;

// A word is only worth timing if nothing was in flight when it started: his own voice quiet
// for a moment, and the avatar's mouth quiet too. A word that rides in on top of an answer
// already on its way cannot be told apart from that answer, and a figure taken from it puts
// the voice further ahead of the mouth than the guess it replaced.
const VOICE_QUIET = 1.0;
const FACE_QUIET  = 0.5;
// A picture that has just appeared is not a face answering a word: the engine's own arrival
// is the largest movement in the whole call, and crediting it is how one number, taken once,
// could sit wrong on the cable for the rest of it.
const SETTLE_SEC  = 1.2;

const HIST_SAMPLES = 100;  // the trailing window the face's resting movement comes from
const MIN_HIST     = 8;    // no decision until that window has something to stand on
const LAG_SAMPLES  = 12;   // trailing answers the held figure is taken from
const MIN_ANSWERS  = 2;    // one spike is a fluke; the card only believes two

// What counts as a face answering, relative to what the face does while nobody is talking.
const MIN_MOVE   = 0.004;
const MOVE_RATIO = 2.2;

export interface LipSyncSample {
  /** The app heard his voice on this sample. */
  talking: boolean;
  /** Movement inside the face band, 0..1. Only meaningful while `picture` is true. */
  motion: number;
  /** The avatar's picture is on screen and being sampled. */
  picture: boolean;
  /** Seconds on a real clock - not a tick count, because a backgrounded window ticks
   *  slowly and a slow timer must never be read as a slow engine. */
  at: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export class LipSyncEstimator {
  /** Seconds of voice the cable is holding back right now. */
  hold = DEFAULT_HOLD;
  /** Whether `hold` is a timed figure or still the standing guess. */
  measured = false;
  /** The picture keeps up with his voice, so the cable holds nothing. This is a decision
   *  made from what it saw, not an absence of one: the card may say so. */
  live = false;

  private motion: number[] = [];
  private lags: number[] = [];
  private fastMoves = 0;
  private onsetAt: number | null = null;
  private wasTalking = false;
  private pictureAt: number | null = null;
  private voiceQuietSince = 0;
  private faceQuietSince = 0;

  reset(): void {
    this.hold = DEFAULT_HOLD;
    this.measured = false;
    this.live = false;
    this.motion = [];
    this.lags = [];
    this.fastMoves = 0;
    this.onsetAt = null;
    this.wasTalking = false;
    this.pictureAt = null;
    this.voiceQuietSince = 0;
    this.faceQuietSince = 0;
  }

  push(s: LipSyncSample): void {
    if (!s.picture) {
      // A picture that goes away - a reconnect, a tab left and come back to - voids the
      // floor it was measured against and any word still waiting for an answer.
      this.pictureAt = null;
      this.motion = [];
      this.onsetAt = null;
      this.wasTalking = s.talking;
      if (s.talking) this.voiceQuietSince = s.at;
      return;
    }
    if (this.pictureAt === null) {
      this.pictureAt = s.at;
      this.motion = [];
      this.onsetAt = null;
      this.faceQuietSince = s.at;
    }
    const settled = s.at - this.pictureAt >= SETTLE_SEC;
    const bar = this._bar();
    // How long each side has been quiet, read before this sample is allowed to count.
    const faceQuietFor = s.at - this.faceQuietSince;
    const voiceQuietFor = s.at - this.voiceQuietSince;
    if (settled) {
      this.motion.push(s.motion);
      if (this.motion.length > HIST_SAMPLES) this.motion.shift();
    }
    if (s.motion > bar) this.faceQuietSince = s.at;
    if (s.talking) this.voiceQuietSince = s.at;

    if (s.talking && !this.wasTalking) {
      const clean = faceQuietFor >= FACE_QUIET && voiceQuietFor >= VOICE_QUIET;
      this.onsetAt = settled && this.motion.length > MIN_HIST && clean ? s.at : null;
    }
    this.wasTalking = s.talking;

    if (this.onsetAt === null) return;
    const waited = s.at - this.onsetAt;
    if (waited > MAX_LAG) { this.onsetAt = null; return; }  // nothing answered that word
    if (!settled || s.motion <= bar) return;

    this.onsetAt = null;
    if (waited < MIN_LAG) {
      // The mouth moved with the word instead of after it. Counted, because a call that does
      // this repeatedly is not a slow engine nobody can time - it is a picture that keeps up,
      // and a voice held 0.8 seconds behind it is the desync.
      this.fastMoves++;
      // Nothing ever answered a word inside the time an answer needs, and half a minute of the
      // picture has gone by: the mouth is following him, not waiting for him. Let the voice go.
      // A call this far in with no clean word at all - nobody spoke, or never a pause - never
      // reaches here, and keeps the guess, because dropping to nothing would run the voice ahead
      // of a picture that may simply be slow.
      if (!this.measured && this.lags.length === 0 && this.fastMoves >= LIVE_MOVES &&
          s.at - this.pictureAt >= NEAR_LIVE_SEC) {
        this.live = true;
        this.hold = 0;
      }
      return;
    }
    this.lags.push(waited);
    if (this.lags.length > LAG_SAMPLES) this.lags.shift();
    this.hold = Math.min(MAX_HOLD, Math.max(MIN_HOLD, median(this.lags)));
    // A word that did have to wait for its mouth overturns any earlier reading of a live
    // picture: the held figure now comes from measurements, which is better evidence.
    this.live = false;
    if (this.lags.length >= MIN_ANSWERS) this.measured = true;
  }

  /** The quietest recent movement of this face: an answer has to beat it. */
  private _bar(): number {
    let lo = 1;
    for (let i = 0; i < this.motion.length - 1; i++) if (this.motion[i] < lo) lo = this.motion[i];
    return Math.max(lo + MIN_MOVE, lo * MOVE_RATIO);
  }
}
