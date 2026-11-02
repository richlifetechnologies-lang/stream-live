// The decision a customer's complaint turns on: when the app has asked for a call and
// been refused, does it ask again, how long does he wait, and what does he finally read?
//
// Kept apart from the page on purpose — the page cannot run without a camera, a
// microphone and a live gateway, so this is what can be proven on paper. Nothing in here
// may put a provider's words on the screen: the engine's raw reason goes to
// reportCallFailure, the customer gets one of the sentences in end-reason.
import { endReasonMessage } from "./end-reason";

/**
 * How many times one press of Start may ask for a call, and how long it waits between
 * asks.
 *
 * Measured on this gateway over 30 days, on the paid video calls: one asked for less than
 * a minute after that same machine's previous ask reached a picture 4 times in 55, and one
 * asked a minute or later reached it 9 times in 33. So waiting genuinely helps, and the
 * server now does the measuring - see the pacing gate in sl_start_session. The two waits
 * below are only for the case where the video line took the call and died without the
 * server having anything to say about timing. A paid call that never delivered a frame is
 * not billed, so a repeat costs nothing but the waiting; the waits stay short because a
 * press that spends a minute and a half re-asking something broken is worse than one that
 * says so honestly in twenty seconds.
 */
export const START_TRIES = 3;
export const START_RETRY_WAITS_MS = [10_000, 30_000];

/**
 * A free-trial press asks once and stops.
 *
 * The re-ask was built for the paid line, whose refusals are a slot being busy a few seconds
 * longer than the last call held it. The trial has never been measured failing that way, and a
 * customer spending forty seconds watching "retrying" on a call that is simply not starting is
 * a worse screen than one honest sentence at the thirteen-second mark.
 */
export const TRIAL_START_TRIES = 1;

/**
 * How long this app is willing to sit on a call that has never put a picture on screen.
 *
 * Nothing is billed for those seconds - the gateway meters from the first frame - so they are
 * the seller's cost alone, spent on a delivery that is not coming. The gateway closes the same
 * call at its first check-in, which the page runs every 45 seconds; giving up here rather than
 * there is what turns ~45 seconds of engine into ~40, and it puts the honest sentence in front
 * of the customer while he is still looking at the black box instead of leaving him to press
 * Stop at a minute and a half, which is what the three blank calls of 2026-11-01 were.
 */
export const PICTURE_GIVE_UP_MS = 40_000;

/**
 * A call that showed no picture ends with this machine held off the next one, in seconds.
 *
 * This is the ordinary hold the server's own machine gate (sl_start_session) puts on a device,
 * so it is the wait the customer is told and the wait he can see counting down. Holding it at
 * the server's longest figure instead would keep a man out for four minutes when his line
 * released at two - dead time for him and unsold minutes for the seller. When this machine
 * really is on the longer window, his first press after the count is refused and the answer
 * carries the exact seconds left, which the button then counts; the wait is corrected by the
 * only party that measured it, and a refused press costs nobody anything.
 */
export const BLIND_RETRY_HOLD_SECONDS = 120;
export const BLIND_RETRY_HOLD_MS = BLIND_RETRY_HOLD_SECONDS * 1000;
/** A wait the server announced, clamped: one second is not a pause, an hour is not his day. */
export const PACED_WAIT_MIN_MS = 5_000;
export const PACED_WAIT_MAX_MS = 240_000;

/** Why one ask failed, and whether asking again is the right answer to it. */
export type StartFailure = {
  retryable: boolean;
  stage: "gateway" | "engine";
  detail: string;
  reason?: string;
  sessionId: string | null;
  /**
   * Which video line the gateway put this call on, as it answered. The trial line and the paid
   * line fail for different reasons, so the press that has to decide whether to ask again needs
   * to know which one it is holding - and only the gateway's own answer says so.
   */
  engine: string | null;
  /**
   * Milliseconds the server asked this machine to wait before it presses again, or null
   * when it announced no wait. It is a number the gateway measured on this exact machine,
   * so it beats the table above.
   */
  waitMs: number | null;
};

/**
 * What the gateway answered, sorted into the three kinds of refusal.
 *
 * pReason is a gateway reason code when the account itself was refused — no minutes, no
 * plan, wrong device, an old build. Those answers do not change by repeating, so they end
 * the press at once. A refusal that arrives with a wait attached is different in kind: the
 * server is not refusing the account, it is releasing the video line this machine used a
 * few seconds ago. The press still ends, because the pause is minutes long and it is the
 * machine's owner who should decide to spend it - but the number comes back in `waitMs` so
 * the page can hold its button for exactly that long.
 *
 * Everything else is the video line taking the call and then not producing a picture,
 * which is exactly the failure a second ask cures.
 */
export function classifyStartFailure(
  pReason: string | null,
  detail: string,
  sessionId: string | null,
  waitSeconds: number | null = null,
  engine: string | null = null,
): StartFailure {
  const announced = Number(waitSeconds);
  const waitMs = Number.isFinite(announced) && announced > 0
    ? Math.min(Math.max(Math.round(announced) * 1000, PACED_WAIT_MIN_MS), PACED_WAIT_MAX_MS)
    : null;
  if (pReason !== null) {
    return {
      retryable: waitMs !== null || pReason === "upstream_key",
      stage: "gateway",
      detail: `gateway refused (${pReason})`,
      reason: pReason,
      sessionId,
      engine,
      waitMs,
    };
  }
  return { retryable: true, stage: "engine", detail, sessionId, engine, waitMs: null };
}

/**
 * A call this app refused before it ever asked the gateway for one — the microphone is not
 * there, the voice service will not answer, the administrator has closed cloning.
 *
 * Nothing was booked, so nothing can be given back, and asking again in ten seconds fixes
 * none of it. These come straight to the customer as their own sentence.
 */
export function preflightFailure(reason: string): StartFailure {
  return {
    retryable: false,
    stage: "gateway",
    detail: `refused before the call (${reason})`,
    reason,
    sessionId: null,
    engine: null,
    waitMs: null,
  };
}

/**
 * How many asks this press may make. The trial line asks once; everything else keeps the
 * paid line's three, which is what the measurements behind the table above were taken on.
 */
export function startTriesFor(f: StartFailure): number {
  return f.engine === "decart" ? TRIAL_START_TRIES : START_TRIES;
}

/**
 * How long to wait before ask number tryIndex+2, or null when this press is over.
 *
 * A call that never showed a frame is not billed, so a repeat costs the account nothing
 * but a few seconds of waiting — which is still cheaper than the "cannot start" message.
 *
 * A wait the server announced for this machine is the one answer this press does not make
 * itself. The number runs to minutes, and dialing again by himself while the video line is
 * still being released is exactly the restart loop the gate exists to stop; worse, an app
 * that re-dials on its own contradicts the sentence it just showed the customer. So the
 * seconds travel back to the page on the failure's own `waitMs` field, and he presses again
 * when the count reaches zero.
 */
export function startRetryWaitMs(f: StartFailure, tryIndex: number, tries = START_TRIES): number | null {
  if (!f.retryable) return null;
  if (f.waitMs !== null) return null;
  if (tryIndex + 1 >= tries) return null;
  return START_RETRY_WAITS_MS[tryIndex] ?? null;
}

/**
 * The one refusal a repeat can never fix, read out of the engine's own words.
 *
 * A call pass is booked seconds before the dial and lives minutes, so a pass the engine
 * reports as expired more than an hour ago cannot have been spent by time passing: only a
 * machine whose clock is hours away from real time reads it that way. That sentence is the
 * clock's signature, and it is worth a different message from a dead video line because the
 * customer can fix it himself.
 */
export function clockRefusedThePass(detail: string): boolean {
  const m = /expired (\d+) s ago/i.exec(detail);
  return m !== null && Number(m[1]) * 1000 > 3_600_000;
}

/**
 * The sentence shown when this press of Start is finished with.
 *
 * A gateway reason always maps to its own plain sentence. A call that opened and died is
 * the one case where the app has already done something about it, so it gets the sentence
 * that says so. Nothing here can return the engine's own words.
 */
export function startFailureMessage(f: StartFailure): string {
  // The machine's clock, not the video line: say which, because they are fixed in different
  // places and only one of them is somewhere the customer can reach.
  if (f.stage === "engine" && clockRefusedThePass(f.detail)) return endReasonMessage("clock_skew");
  return endReasonMessage(f.reason ?? (f.stage === "engine" ? "engine_no_answer" : null));
}
