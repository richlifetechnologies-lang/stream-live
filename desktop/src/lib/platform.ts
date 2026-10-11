// The desktop app reaches calling apps through one loopback audio device and one
// virtual camera per OS. Windows ships both in the installer; macOS cannot host
// an unapproved system camera extension, so video goes through OBS there.
export const IS_MAC =
  typeof navigator !== "undefined" &&
  (/Mac/i.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent));

/** Name the user sees in Zoom / Teams / OBS pickers. */
export const CABLE_NAME = IS_MAC ? "BlackHole 2ch" : "VB-Audio Virtual Cable";

/** Loopback render endpoint (the "speaker" half the app writes AI audio to). */
export const CABLE_OUTPUT_RE = IS_MAC
  ? /blackhole/i
  : /(cable[- ]input|stream live speaker|stream studio speaker|speakers \(vb-audio)/i;

/** Either half of the cable — the capture endpoint shares its groupId. */
export const CABLE_ANY_RE = IS_MAC
  ? /blackhole/i
  : /(cable|vb-?audio|vb-?cable|stream live|stream studio)/i;
