// Automatic microphone handling: no switch, no threshold for anyone to set.
//
// Every customer answers "is noise cancellation on?" differently, and most never look. So the
// app learns two things from the call itself - what THIS room sounds like when they are quiet,
// and how loud THEIR voice actually is - and drives the level meter, the microphone gate and how
// far the AI is let in from that one pair of numbers.
//
// The gate closes both copies of your voice: the one that goes out to your callers - the virtual
// microphone - and the one that is written down for the AI to read. A fan or a television is then
// not carried down the line as if it were you, and the same noise cannot come back dressed in your
// own voice. The leg that is written down is held 0.15 s behind the speaker first, so the closing
// reaches a word that has already been heard rather than the one you are starting; nothing you say
// is lost to the delay.

// Fractions of the customer's own dynamic range (between their silence and their loudest speech).
const OPEN_FRAC  = 0.30;   // this far above the room floor counts as speaking
const CLOSE_FRAC = 0.18;   // and it has to fall this far back before the voice is considered over
const MIN_SPREAD = 0.06;   // the smallest range the meter will ever divide by
// ...but a voice is never asked to clear a bar it cannot reach. Proportional thresholds alone
// lock shut behind one loud event: a chair scraping, or the avatar's own voice coming out of
// speakers into the open microphone, makes the learned peak so high that ordinary speech falls
// under it and is then held as silence. These caps are the most the gate will ever demand above
// the room floor, however loud the loudest moment was.
const OPEN_CAP   = 0.05;
const CLOSE_CAP  = 0.035;

// Times, in seconds.
const HOLD_SECONDS   = 0.45;  // stays open this long after the voice drops, so the tail of a
                              // word - and the first word after a pause - is never clipped
const ARM_SECONDS    = 3.0;   // never cuts anything before it has heard this much of the room
const ARM_SPREAD     = 0.10;  // and never before their silence and their voice are this far apart

const FLOOR_RISE_PER_SEC = 0.05;  // the room floor drifts up slowly, but drops instantly
// A level this far above the floor is a person, not the room. Without this the floor climbs into
// any speech the gate has failed to recognise, the range it measures collapses to nothing, and
// the gate never opens again - which is how one misheard word can go on hiding every word after
// it. The room does not jump 0.05 in a fraction of a second; a voice does.
const FLOOR_STEP         = 0.05;
// The loudness peak is forgotten quickly. Holding it for minutes lets a single bang decide how
// loud the customer is allowed to be for the rest of the call.
const VOICE_FALL_PER_SEC = 0.10;

export class VoiceGate {
  floor    = 0;
  voice    = 0;
  talking  = false;
  // True only for the sample itself: the level is over the open bar RIGHT NOW. `talking` stays
  // true for 0.45 s after the voice drops so a word tail is never cut, which is also long enough
  // to turn a short click into most of a second of "speech" - so the two are counted apart.
  voiced   = false;
  muted    = false;
  armed    = false;
  started  = false;

  private seen      = 0;
  private lastVoice = 0;

  // level: 0..1 voice-band energy for one sample of the microphone.
  update(level: number, dtSec: number): void {
    if (!this.started) {
      this.floor = level; this.voice = level; this.started = true;
    }

    const spread = Math.max(this.voice - this.floor, MIN_SPREAD);
    const openAt  = this.floor + Math.min(OPEN_FRAC  * spread, OPEN_CAP);
    const closeAt = this.floor + Math.min(CLOSE_FRAC * spread, CLOSE_CAP);

    this.voiced = level > openAt;
    if (this.voiced) {
      this.talking = true;
      this.lastVoice = this.seen;
    } else if (this.talking && level < closeAt && this.seen - this.lastVoice > HOLD_SECONDS) {
      this.talking = false;
    }

    // Learned only after the decision, so a burst of speech cannot move the target it is
    // being compared against and shut itself off mid-word.
    if (level < this.floor) this.floor = level;
    else if (!this.talking && level - this.floor <= FLOOR_STEP) {
      this.floor = Math.min(level, this.floor + FLOOR_RISE_PER_SEC * dtSec);
    }

    if (this.talking) this.voice = Math.max(this.voice, level);
    else this.voice = Math.max(this.floor, this.voice - VOICE_FALL_PER_SEC * dtSec);

    this.seen += dtSec;
    this.armed = this.seen >= ARM_SECONDS && this.voice - this.floor >= ARM_SPREAD;
    this.muted = this.armed && !this.talking;
  }

  // The meter is the customer's voice measured against their own silence, so a normal speaking
  // level lands in the middle of the bar instead of pinning it the instant they open their mouth.
  vu(level: number): number {
    const spread = Math.max(this.voice - this.floor, MIN_SPREAD);
    return Math.round(Math.max(0, Math.min(1, (level - this.floor) / spread)) * 100);
  }

  reset(): void {
    this.floor = 0; this.voice = 0; this.talking = false; this.voiced = false; this.muted = false;
    this.armed = false; this.started = false; this.seen = 0; this.lastVoice = 0;
  }
}

// What the gate is doing right now, in the four states a customer can act on. The screen says
// this and nothing more technical, because it is the one place he can see that his microphone is
// being heard at all - with no call running and therefore no minutes spent.
export type GateState = "silent" | "learning" | "open" | "quiet";

export function gateState(g: VoiceGate): GateState {
  if (!g.started) return "silent";
  if (!g.armed)   return "learning";
  return g.talking ? "open" : "quiet";
}

// Mean energy across the band a human voice actually occupies. A full-spectrum figure is useless
// for this: hiss and fan noise are broadband, and averaging them with the voice band leaves almost
// nothing to tell speech apart from an empty room.
export function voiceBandLevel(freq: Uint8Array, sampleRate: number, loHz = 100, hiHz = 3400): number {
  const binHz = (sampleRate / 2) / freq.length;
  const lo = Math.max(1, Math.floor(loHz / binHz));
  const hi = Math.min(freq.length - 1, Math.ceil(hiHz / binHz));
  let sum = 0, n = 0;
  for (let i = lo; i <= hi; i++) { sum += freq[i]; n++; }
  return n ? sum / (n * 255) : 0;
}
