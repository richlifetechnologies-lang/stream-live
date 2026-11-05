// A blank screen has four different causes, and only two of them are the customer's to fix.
// This decides which one this machine actually saw, from the signals it already holds: whether
// his own camera was putting frames into the app, whether a connection ever came up between
// this computer and the video line, and what the video service answered when it was asked.
//
// Nothing in here may guess. A signal this app does not have is reported as unknown, and an
// unknown never becomes a sentence on his screen — it falls through to the honest "no picture
// arrived", which is the one thing both remaining cases genuinely have in common.

/** What this machine could see while the call sat blank. */
export type NoPictureEvidence = {
  /** The camera frame counter produced a number during this call, so the reading below is real. */
  cameraSeen: boolean;
  /** The camera put at least one frame on screen since this call opened. */
  cameraProducing: boolean;
  /** A connection between this computer and the video line came up at some point in this call. */
  connected: boolean;
  /**
   * The video service's own answer, when the call died because it refused to take the dial
   * rather than because it took it and produced nothing. Empty for every other death.
   */
  lineAnswer: string;
};

/**
 * The causes, as they are written into the gateway's log and as their sentences are
 * keyed in `end-reason`. `picture_hold` is the honest remainder: the line is connected and
 * this machine's camera is feeding it, and still nothing painted.
 *
 * `line_full` and `photo_too_big` are the two causes that are never the customer's: the video
 * service said no at the door, in its own words, before any connection of his was ever involved.
 * Neither of them may fall through to `never_connected`, which tells a man to go and switch off a
 * VPN over a fault that no VPN on his machine could have caused.
 */
export type NoPictureCause = "line_full" | "photo_too_big" | "camera_stalled" | "never_connected" | "picture_hold";

/**
 * The video service's own wording for a line that was not free.
 *
 * These sentences come back on the live call socket, in the service's words rather than ours,
 * and they arrived in the records of 2026-11-02 and 2026-11-03 attached to dials that died two
 * to four seconds after opening while the seller's own gateway had no call running at all. Only
 * the wording identifies them: nothing else in this app knows that a line was refused.
 */
export function lineFullRefusal(answer: string): boolean {
  return /concurrent session limit|server at capacity|at capacity|too many (?:concurrent )?(?:sessions|calls)|line(?:s)? (?:are )?(?:full|busy)/i
    .test(answer);
}

/**
 * The video service's own wording for a message it will not read.
 *
 * Close code 1009 means one thing in the protocol the call runs on: the other side was handed a
 * message bigger than it will accept and shut the socket instead of answering it. This product
 * sends exactly one oversized message - the customer's photo, which goes out twice per dial - so
 * 1009 names the photo, not his network and not our capacity. Proved on 2026-11-05: nine blank
 * calls on one machine all closed 1009, while the same device, the same network and the same call
 * pass carried 78 and 93 seconds of picture between them.
 *
 * The bare code is matched as well as the wording, because the app only ever had the code until
 * this build started keeping the reason that came with it.
 */
export function photoTooBigRefusal(answer: string): boolean {
  return /\b1009\b|message too big|too big (?:for|to be read by)|frame is too large|maximum message (?:size|length)/i
    .test(answer);
}

/**
 * Which cause the evidence supports, in the order a person can act on it.
 *
 * The service's own refusal is asked first, because it decides the case from the far side: a
 * dial that was never taken says nothing about this camera and nothing about this network, and
 * blaming either of them for it costs the customer his evening on a fix that was never his.
 *
 * The camera is asked next, because a starved camera explains a blank exactly as well as a
 * dead line does and is fixed with a cable and a drop-down instead of a support message. It is
 * only ever blamed when the counter ran and counted nothing: a counter that never produced a
 * number says nothing about anything, and accusing a working camera is worse than a vague
 * sentence.
 */
export function noPictureCause(e: NoPictureEvidence): NoPictureCause {
  if (photoTooBigRefusal(e.lineAnswer)) return "photo_too_big";
  if (lineFullRefusal(e.lineAnswer)) return "line_full";
  if (e.cameraSeen && !e.cameraProducing) return "camera_stalled";
  if (!e.connected) return "never_connected";
  return "picture_hold";
}

/**
 * The same evidence in the words his administrator reads, and nobody else.
 *
 * This is the line that goes to the failure log, where the panel groups blanks by machine and
 * by side of the cable. It carries all three signals even when one of them decided nothing,
 * because "counter never ran" and "was feeding frames" are different facts to a man hunting a
 * leak.
 */
export function noPictureDetail(e: NoPictureEvidence, cause: NoPictureCause, clockNote: string): string {
  const camera = !e.cameraSeen ? "camera counter gave no reading"
    : e.cameraProducing ? "camera was feeding frames"
    : "camera fed no frame at all";
  const line = cause === "line_full"
    ? `the video service refused the dial: ${e.lineAnswer.slice(0, 120)}`
    : cause === "photo_too_big"
    ? `the video service refused the message carrying the photo: ${e.lineAnswer.slice(0, 120)}`
    : e.connected ? "the connection came up and carried no picture"
    : "no connection came up between this machine and the video line";
  return `cause=${cause} (${camera}; ${line})${clockNote}`;
}
