// A blank screen has three different causes, and only two of them are the customer's to
// fix. This decides which one this machine actually saw, from the signals it already holds:
// whether his own camera was putting frames into the app, and whether a connection ever came
// up between this computer and the video line.
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
};

/**
 * The three causes, as they are written into the gateway's log and as their sentences are
 * keyed in `end-reason`. `picture_hold` is the honest remainder: the line is connected and
 * this machine's camera is feeding it, and still nothing painted.
 */
export type NoPictureCause = "camera_stalled" | "never_connected" | "picture_hold";

/**
 * Which cause the evidence supports, in the order a person can act on it.
 *
 * The camera is asked first, because a starved camera explains a blank exactly as well as a
 * dead line does and is fixed with a cable and a drop-down instead of a support message. It is
 * only ever blamed when the counter ran and counted nothing: a counter that never produced a
 * number says nothing about anything, and accusing a working camera is worse than a vague
 * sentence.
 */
export function noPictureCause(e: NoPictureEvidence): NoPictureCause {
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
  const line = e.connected ? "the connection came up and carried no picture"
    : "no connection came up between this machine and the video line";
  return `cause=${cause} (${camera}; ${line})${clockNote}`;
}
