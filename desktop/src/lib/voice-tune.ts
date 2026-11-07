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
//   Similarity - "sounds cleaner", which that line says is the LOW end too. So the rule never rises
//                above the app's own figure and goes further down the louder his room is.
//
// The LOW END OF THESE TWO DIALS MOVED ON 6 NOVEMBER, and the reason is his own listening. The old
// Stability band ran down to 0.25, and 0.25 is a long way into the region the voice service itself
// describes as randomness between generations: a voice delivered at 0.25 comes back at a slightly
// different tone every sentence, which is exactly the fault he wrote in as "spikes of high and low
// pitch". The help line under the dial is still honoured - the livelier end of the band is still the
// lower number - but the band now sits around the service's own published middle, where a voice keeps
// ONE tone across a call and still rises and falls inside a sentence. Nothing here goes to the top of
// the dial either, because the vendor's own reading of a high Stability is a flat, machine-like voice.
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
//
// Both defaults now sit INSIDE the bands below, and that is deliberate. Until 1.8.48 the manual
// Similarity started at 0.80 while the automatic choice could never go above 0.55, so a customer who
// turned Choose for me off landed on a figure the app itself had rejected as too close a copy - and
// the vendor's own words are that a high similarity on a poor sample copies the noise with it. A dial
// that starts outside the range the app believes in is a setting nobody explained.
export const VOICE_STABILITY_DEFAULT  = 0.5;
export const VOICE_SIMILARITY_DEFAULT = 0.55;

// Similarity, and the standing ask is the low end of its own explanation too: "Lower sounds cleaner".
// A quiet room lets the copy sit a little closer to his voice without bringing anything else with it;
// a room that is loud against his voice is held further back, because copying a noisy sample copies
// the noise onto the line as well. The top of the band is the app's own starting figure, so the
// automatic choice can agree with the dial or undercut it, never overshoot it. Neither end is 0:
// that is the figure his own last test call ran on, and the call he reported back as several
// different voices in one.
const SIMILARITY_QUIET = 0.55;
const SIMILARITY_LOUD  = 0.35;

// Stability - the dial the card describes as "How much the voice moves while it talks. Higher is even
// and careful. Lower sounds more like a person". The band is 0.50 to 0.60.
//
// It used to be 0.25 to 0.45, and that is the root of the tone spikes he reported on 6 November. The
// service's own published meaning of this figure is how much RANDOMNESS is allowed between
// generations: at 0.25 every sentence is a fresh reading of the voice, so one comes back a shade high
// and the next a shade low, which is heard as the same person changing register mid-call. The middle
// of the dial is where the voice keeps one register across a call and still rises and falls INSIDE a
// sentence, which is the standing ask in his own words: a steady tone that does not sound flat.
// 0.60 is the ceiling rather than higher, because the vendor's own reading of a high Stability is a
// monotonous voice with limited emotion - the other complaint on this card.
const STABILITY_HELD   = 0.60;
const STABILITY_PERSON = 0.50;

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
   * The level of HIM at his own microphone: the average of exactly the frames the gate called his
   * voice. Zero until enough of him has been heard. The engine compares one piece's own average
   * against this figure to decide whether a piece can be him at all, so it has to be the same
   * measurement taken two ways - the same analyser, the same band, the same gate verdict - and never
   * a peak, because a peak is what a door slam produces.
   */
  get mean(): number {
    if (this.n < MIN_TRACK_FRAMES) return 0;
    return this.sum / this.n;
  }

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

  // His voice rose and fell as he talked: the line is asked to do the same, which is the livelier end
  // of this dial's own explanation - the lower figure, inside a band that no longer reaches the
  // randomness that changes a voice's register between sentences. His voice held one level: nothing on
  // his side asks for movement, so it may be held even with him - and "held", not "highest", is as far
  // as this rule is allowed to go. Nothing of his speech heard yet: the app's own figure, unchanged and
  // admitted.
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
