// A voice call can fail in five different places, and until now it reported as one of them
// whatever the video line's answer happened to be. That is why twelve calls that died inside this
// app's own code were filed as "no connection came up between this computer and the video line" —
// a sentence about a man's VPN, on a call that has no video line at all.
//
// This decides which place it actually failed, from signals this machine already holds: whether it
// ever got a microphone, what that microphone's loudest moment measured, whether the app caught a
// word from it, how many pieces left for the voice service, and how many came back with audio in
// them. Nothing in here may guess. A signal the app does not have is written as unknown in his
// administrator's line and never becomes a sentence on his screen.
//
// The raw voice-service words go only to the failure log. The customer gets one of the sentences in
// end-reason, in his own language, and none of them can name a provider.

/** What this machine could see while the cloned voice stayed missing. */
export type VoiceEvidence = {
  /** A microphone was handed to this app at all — opened, or refused by Windows, or absent. */
  micOpened: boolean;
  /**
   * The loudest voice-band level this app measured on that microphone during this call, on the
   * raw 0..1 scale the analyser reports (not the meter's gate-relative one, which reads zero in a
   * quiet room with a working microphone). Null means this app never got to sample the
   * microphone at all — which is not silence, and must never be written as though it were.
   */
  micPeak: number | null;
  /** The app's own speech detector caught a word from him during this call. */
  wordHeard: boolean;
  /** His microphone track shut while the call was running (unplugged, or taken by another app). */
  micStopped: boolean;
  /** Pieces this app recorded and handed to the voice service. */
  piecesSent: number;
  /** Pieces it caught as speech and then found to hold no signal, so they never left. */
  piecesEmpty: number;
  /** Answers that came back from the voice service with audio in them. */
  piecesBack: number;
  /** Whether any cloned audio reached his speakers. */
  onAir: boolean;
  /**
   * The voice service's own words, or the words of whatever this app threw, when the call died by
   * being refused rather than by being accepted and answering nothing. Empty for every other death.
   */
  answer: string;
};

/**
 * The five places a voice call fails, plus the two it borrows.
 *
 * `mic_not_ready` is the reason the pre-flight already uses — kept as a cause here so the give-up
 * and the pre-flight can never say two different things about the same microphone. `app_crashed`
 * and `no_word_heard` are the two that were being swallowed: the first filed under a video cause
 * that told a man to switch off a VPN, the second indistinguishable from our own service going
 * quiet, when in fact nobody on the call had said anything yet.
 *
 * `nothing_sent`, `service_silent` and `voice_hold` are all ours, and none of them may be said in
 * a way that sends him checking his cables.
 */
export type VoiceCause = "app_crashed" | "mic_not_ready" | "mic_silent" | "no_word_heard"
  | "nothing_sent" | "service_silent" | "voice_hold";

/**
 * The side of the cable a cause belongs to, in one word, for his administrator's table.
 *
 * The panel groups a voice blank by whose problem it is, and the same word must not cover a muted
 * microphone and a silent voice service — they are fixed in different buildings.
 */
export const VOICE_CAUSE_SIDE: Record<VoiceCause, "his machine" | "our app" | "our voice service"> = {
  app_crashed: "our app",
  mic_not_ready: "his machine",
  mic_silent: "his machine",
  no_word_heard: "his machine",
  nothing_sent: "our app",
  service_silent: "our voice service",
  voice_hold: "our app",
};

/**
 * Silence, measured rather than decided.
 *
 * `voiceBandLevel` averages the voice band and divides by 255 per bin, so a single frequency bin at
 * full scale — one pure tone, a squeal, a desk thump — is worth about 1/560 of this figure.
 * Anything under half of that cannot have come out of a room: only a muted or dead capture device
 * reads this low for a whole call. A working microphone in a silent house still carries its own
 * hiss above this line, which is exactly why the meter's own bar is NOT used here — the bar is
 * relative to a learned floor, and it legitimately shows zero when nothing is wrong.
 */
export const MIC_DEAD_LEVEL = 0.5 / 560;

/**
 * Words that can only have come from this app's own code failing.
 *
 * A network, a video line or a voice service cannot throw a JavaScript property error, so when the
 * message that arrives on the failure path reads like one, the call never went anywhere and no
 * connection was ever being asked for. Naming it here is what stops the same crash from being
 * reported — to the customer and to his administrator — as a machine that will not connect.
 */
export function appFaultTheCall(answer: string): boolean {
  return /cannot read propert|cannot set propert|is not a function|is not defined|of undefined|of null|^\s*(TypeError|ReferenceError|RangeError|SyntaxError)\b/i
    .test(answer);
}

/**
 * Which of the five places this machine's own signals say the call failed in, asked in the order a
 * person can act on.
 *
 * This app's own crash is first because it decides the case before anything was asked of anyone:
 * while the call was still being opened, nothing his microphone or our service did can explain it.
 *
 * His microphone is next, and only convicted on evidence that cannot be read another way — a
 * capture that measured silence for the whole call. A microphone that carried sound but produced no
 * piece is NOT called his fault, because the app's own speech gate is the thing that decides that,
 * so it gets the cause that says only that no word was caught.
 *
 * Then the four numbers, which separate our app not sending from our service not answering.
 */
export function voiceCause(e: VoiceEvidence): VoiceCause {
  if (appFaultTheCall(e.answer)) return "app_crashed";
  if (!e.micOpened) return "mic_not_ready";
  if (e.micPeak !== null && e.micPeak <= MIC_DEAD_LEVEL) return "mic_silent";
  if (e.piecesSent === 0) return e.wordHeard ? "nothing_sent" : "no_word_heard";
  if (e.piecesBack === 0) return "service_silent";
  return "voice_hold";
}

/**
 * The same evidence in the words his administrator reads, and nobody else.
 *
 * All of it is written even when one figure decided the cause, because "the app heard 6 words and
 * sent 5 pieces" and "the app heard nothing and sent nothing" are different hunts, and the two of
 * them used to leave the same single line: no cloned audio.
 */
export function voiceDetail(e: VoiceEvidence, cause: VoiceCause, note: string): string {
  const mic = !e.micOpened ? "no microphone reached this app"
    : e.micPeak === null ? "the app never got to sample his microphone"
    : `microphone peaked at ${e.micPeak.toFixed(4)}${e.micPeak <= MIC_DEAD_LEVEL ? " = digital silence" : ""}`;
  const words = e.wordHeard ? "the app caught words from it" : "the app caught no word from it";
  const sent = `${e.piecesSent} piece${e.piecesSent === 1 ? "" : "s"} sent to the voice service`
    + (e.piecesEmpty ? `, ${e.piecesEmpty} found empty before leaving` : "");
  const back = `${e.piecesBack} answer${e.piecesBack === 1 ? "" : "s"} came back`;
  const air = e.onAir ? "cloned audio reached his speakers" : "no cloned audio ever reached his speakers";
  const stopped = e.micStopped ? "; his microphone stopped mid-call" : "";
  const said = e.answer ? `; the service or the app answered: ${e.answer.slice(0, 140)}` : "";
  return `cause=${cause} (${mic}; ${words}; ${sent}; ${back}; ${air}${stopped}${said})${note}`;
}

/**
 * What the free microphone check concludes.
 *
 * The check opens the same device a call will use, for the same learning a call runs, so it can
 * answer the one question a customer cannot answer for himself: is sound actually arriving. Three
 * verdicts and no fourth: a device that will not open, a device that sends nothing at all, and a
 * device that is carrying sound. A quiet room is deliberately NOT a failure — it reads as carrying
 * sound, because the level it sits at is above what a muted device can produce, and because telling
 * a man his working microphone is broken is worse than telling him nothing.
 */
export type MicVerdict = "opened" | "silent" | "refused";

export function micVerdict(opened: boolean, peak: number, heardSpeech: boolean): MicVerdict {
  if (!opened) return "refused";
  if (peak <= MIC_DEAD_LEVEL && !heardSpeech) return "silent";
  return "opened";
}

/** The check's own line for his administrator's log, so a call can be read against what the same machine said minutes earlier. */
export function micVerdictDetail(v: MicVerdict, peak: number, seconds: number, device: string): string {
  return `microphone check: ${v === "refused" ? "the device would not open"
    : v === "silent" ? "no signal at all for " + seconds + " s"
    : "carrying sound (" + seconds + " s, peak " + peak.toFixed(4) + ")"} [${device || "no device named by Windows"}]`;
}

/**
 * The line this app's own code failed at, from a thrown error.
 *
 * Until now the app kept the message and threw the rest away, which is how twelve calls on one
 * machine were logged as "Cannot read properties of undefined (reading 'push')" with nothing to
 * say which of the dozens of arrays in this build was the one that was not there - and a hunt of
 * that shape ends with a customer's VPN being blamed, because it is the only nameable thing left.
 * One frame is enough to open the hunt in the right file, and it is worth more than the message:
 * the message is the same twelve times over, the frame names the place.
 *
 * His administrator's log only. A stack trace is not a sentence and must never reach a screen.
 */
export function faultOrigin(err: unknown): string {
  const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : "";
  if (!stack) return "";
  // The first line of a stack is its message, which is already recorded beside this. The next
  // one that reads "at …" is a place.
  const line = stack.split("\n").map(l => l.trim()).find(l => l.startsWith("at "));
  if (!line) return "";
  // Keep the function name, which is the part a person acts on, and shorten the bundle address
  // to the last two segments of its path — a full URL in this line tells him nothing new.
  return line.slice(3)
    .replace(/(?:https?:|app:|file:|webpack:)\/\/[^)\s]*/g, m => m.split(/[\\/]/).slice(-2).join("/"))
    .slice(0, 120);
}
