// The Voice delivery figures, chosen by the app instead of by a slider nobody looked at.
//
// Both of the faults his customers hit come from these two numbers being left at an end: similarity
// at nothing stops the voice following its own sample at all, and stability at nothing lets it
// wander afresh every sentence. Neither is a choice anyone makes on purpose - it is what a dial
// looks like when nobody has thought about it. So the app decides once per call, from what it can
// already hear, and the dials stay exactly where they are as his override.
//
// Nothing new is measured to do this. The engine's own microphone gate already learns how loud the
// room is while he is quiet and how loud he actually is; this reads those two numbers and adds one
// thing the gate already walks past: how level his own voice was while it was talking.
//
// Each figure is therefore chosen from the thing its own help line says it does. Stability moves
// with HOW MUCH HIS VOICE MOVES, because that line is about a voice moving while it talks.
// Similarity moves with HOW LOUD HIS ROOM IS against his voice, because that line is about copying
// a recording noise and all.
//
// And both move inside ONE standing preference, which he has given as a rule this mechanism always
// follows - in the app's own words, the two sentences written under the dials:
//
//   Stability  - "sounds more like a person", which that line says is the LOW end. So the rule works
//                down from a held figure and goes further down the more his own voice moves.
//   Similarity - "sounds cleaner", which that line says is the LOW end too. So the rule sits well
//                under the app's own figure and goes further down the louder his room is.
//
// Neither goes to the bottom of its dial, because the bottom is where his own test call ran: at 0 the
// voice stopped sounding like him and came back a different person every sentence. What his
// microphone says decides within that preference and can never overrule it, and both ends stay
// figures he can set himself, because his own hand is still the last word.
//
// The rule cannot throw, cannot produce a number the dial could never land on, and cannot invent a
// reading: every input is checked, every division is guarded, and a microphone that has heard
// nothing yet hands back the app's own figures and says so.

// Where the card starts, and the figures every call ran on before anyone could move them. They live
// here rather than on the page, so that the automatic choice and the manual dials cannot disagree
// about what "the app's own numbers" means.
export const VOICE_STABILITY_DEFAULT  = 0.4;
export const VOICE_SIMILARITY_DEFAULT = 0.8;

// Similarity, and the standing ask is the low end of its own explanation too: "Lower sounds cleaner".
// A quiet room lets the copy sit a little closer to his voice without bringing anything else with it;
// a room that is loud against his voice is held further back, because copying a noisy sample copies
// the noise onto the line as well. Both ends sit BELOW the app's own figure, which is the point of the
// ask. Neither end is 0: that is the figure his own last test call ran on, and the call he reported
// back as several different voices in one.
const SIMILARITY_QUIET = 0.55;
const SIMILARITY_LOUD  = 0.35;

// Stability, and the standing ask is the low end of its own explanation: "Lower sounds more like a
// person". So the rule sits at or below the app's own figure and only climbs toward the held end when
// his own speech says he does not move much as he talks. The top of the dial is never reached, because
// a voice held at the top stops moving at all - which is his other complaint, the one about the pitch
// going high and low, arriving in the opposite direction.
const STABILITY_HELD   = 0.45;
const STABILITY_PERSON = 0.25;

// The dials move in these jumps, so a figure the app chooses is always one he could land on himself.
const STEP = 0.05;

// The least the app will have listened before it believes the room figure, and the least distance it
// needs between his room and his voice before it will call that a person speaking at all. Below
// either, there is nothing measured - and the honest answer is the app's own figures, said out loud
// on the card rather than passed off as a reading of his room.
export const TUNE_MIN_LISTEN_S = 1.0;
export const TUNE_MIN_SPREAD   = 0.06;

// How much of his own speech the app wants before it will judge how level he is: 25 microphone
// frames is a second and a half of him actually talking, and one loud event is not a way of speaking.
const MIN_TRACK_FRAMES = 25;
// The two ends of the movement scale, measured on his recording of a call rather than guessed: a
// voice that stays at one level sits at or below the first, a voice that rises and falls as it talks
// sits at or above the second. Between them the figure slides, so an ordinary speaker lands on the
// app's own number and only a genuinely level or genuinely lively voice moves off it.
const WANDER_STEADY = 0.35;
const WANDER_MOVING = 0.75;

/**
 * A running note of how his voice behaves while he is speaking.
 *
 * Only frames the gate has already called his voice are let in, so a television or a slammed door is
 * not counted as a way of talking. It holds three numbers - how many frames, their total and the
 * total of their squares - and nothing else, so a call of any length costs the same handful of bytes
 * and no window of recent sound has to be kept.
 */
export class SpeechTrack {
  private n   = 0;
  private sum = 0;
  private sq  = 0;

  // level: one microphone frame's voice-band energy, as the gate itself measured it.
  note(level: number): void {
    // A frame that is not a finite, positive number tells the app nothing, and letting one in would
    // poison the average for the rest of the call.
    if (!Number.isFinite(level) || level <= 0) return;
    this.n += 1; this.sum += level; this.sq += level * level;
  }

  reset(): void { this.n = 0; this.sum = 0; this.sq = 0; }

  get frames(): number { return this.n; }

  /**
   * How much his voice moves while it talks, as the spread of his own levels divided by their
   * average. It has no units on purpose: a quiet man and a loud one are then judged by the same
   * scale, and the microphone's gain cannot decide the answer. Zero means not enough of him has
   * been heard to say anything at all.
   */
  get wander(): number {
    if (this.n < MIN_TRACK_FRAMES) return 0;
    const mean = this.sum / this.n;
    if (!(mean > 0)) return 0;
    // Guarded against a negative variance from rounding: a sum of squares can come out a hair under
    // n*mean*mean for a voice that is genuinely flat, and the square root of a negative is a NaN
    // that would then ride into the dial.
    const variance = Math.max(0, this.sq / this.n - mean * mean);
    return Math.min(4, Math.sqrt(variance) / mean);
  }
}

export type Delivery = {
  stability: number;
  similarity: number;
  // Whether each of the two came from his microphone or is still the app's own figure. The card says
  // which, because a number presented as measured when nothing has been heard is a lie about his call.
  fromVoice: boolean;
  fromRoom:  boolean;
  // Which way the two readings pointed, in the words the help lines under the dials already use.
  steady:    boolean;
  quietRoom: boolean;
};

// Anything the rule hands back must be a figure the dial can show: inside its range and sitting on
// one of its jumps. A NaN escaping this would print as "NaN%" on his screen and be sent to the line.
// The last rounding matters as much as the first: 7 steps of 0.05 is 0.35000000000000003 to a
// computer, and that string would go both to his saved setting and to every speaking request.
function onDial(v: number, lo: number, hi: number): number {
  const c = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
  return Math.round(Math.round(c / STEP) * STEP * 100) / 100;
}

/**
 * floor: how loud his room is when he is quiet. voice: how loud he is. listened: how long the
 * microphone has been running. wander: how much his own voice moved while it talked, from
 * SpeechTrack. The first three are figures the gate already holds; the fourth is the same frames
 * counted a second way.
 */
export function autoDelivery(floor: number, voice: number, listened: number, wander: number): Delivery {
  // A figure that is not a number at all is a broken reading, not a quiet room and not a flat voice.
  // It is answered with the app's own figures and admitted on the card - never with a calculation on
  // nonsense, because one NaN escaping here would print as "NaN%" on his screen and be sent to the
  // line on every sentence of the call.
  const sane = Number.isFinite(floor) && Number.isFinite(voice) && Number.isFinite(listened) && Number.isFinite(wander);
  const f = sane ? Math.max(0, floor) : 0;
  const v = sane ? Math.max(0, voice) : 0;
  const w = sane ? Math.max(0, wander) : 0;

  const spread = v - f;
  const canReadRoom = sane && listened >= TUNE_MIN_LISTEN_S && spread >= TUNE_MIN_SPREAD;

  // How much of his own dynamic range the room eats up. A silent room takes none of it; a room as
  // loud as his whole range takes all of it, and that is when a close copy stops being a copy of him.
  const crowd = canReadRoom ? Math.min(1, Math.max(0, f / spread)) : 0;
  const similarity = canReadRoom
    ? onDial(SIMILARITY_QUIET - (SIMILARITY_QUIET - SIMILARITY_LOUD) * crowd, SIMILARITY_LOUD, SIMILARITY_QUIET)
    : VOICE_SIMILARITY_DEFAULT;

  // His voice rose and fell as he talked: the line is asked to do the same, which is the low, human
  // end the explanation names. His voice held one level: nothing on his side asks for movement, so it
  // may be held even with him - and "held", not "highest", is as far as this rule is allowed to go.
  // Nothing of his speech heard yet: the app's own figure, unchanged and admitted.
  const canReadVoice = sane && w > 0;
  const share = canReadVoice
    ? Math.min(1, Math.max(0, (w - WANDER_STEADY) / (WANDER_MOVING - WANDER_STEADY)))
    : 0;
  const stability = canReadVoice
    ? onDial(STABILITY_HELD - (STABILITY_HELD - STABILITY_PERSON) * share, STABILITY_PERSON, STABILITY_HELD)
    : VOICE_STABILITY_DEFAULT;

  return {
    stability,
    similarity,
    fromVoice: canReadVoice,
    fromRoom:  canReadRoom,
    steady:    share < 0.5,
    quietRoom: crowd < 0.5,
  };
}
