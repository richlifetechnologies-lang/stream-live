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
 * When the server announces a wait, the press asks exactly once more, after that wait.
 * Repeating a paced refusal would be the app arguing with a number that was measured on
 * the machine, and each ask reopens a lease.
 */
export const PACED_RE_ASKS = 1;
/** A announced wait shorter than this is not worth a pause; longer than that is not his day. */
export const PACED_WAIT_MIN_MS = 5_000;
export const PACED_WAIT_MAX_MS = 240_000;

/** Why one ask failed, and whether asking again is the right answer to it. */
export type StartFailure = {
  retryable: boolean;
  stage: "gateway" | "engine" | "voice";
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
 * the press at once. The exception is a refusal that arrives with a wait attached: the
 * server is not refusing the account, it is releasing the video line this machine used a
 * few seconds ago, and asking again after its own announced pause is the answer it gave.
 *
 * Everything else is the video line taking the call and then not producing a picture,
 * which is exactly the failure a second ask cures.
 */
export function classifyStartFailure(
  pReason: string | null,
  needsVideo: boolean,
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
  return { retryable: needsVideo, stage: needsVideo ? "engine" : "voice", detail, sessionId, engine, waitMs: null };
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
 * When the server announced a wait, its number is used, and `waitsUsed` says how many of
 * them this press has already obeyed.
 *
 * The announced number is the whole point of the wait, so it is taken wherever in the
 * press it turns up: a machine that failed its first ask for a reason that had nothing to
 * do with timing can still be told "come back in two minutes" on its second, and throwing
 * that away would leave the customer with a flat failure and a wait he never saw.
 */
export function startRetryWaitMs(f: StartFailure, tryIndex: number, waitsUsed = 0, tries = START_TRIES): number | null {
  if (!f.retryable) return null;
  if (f.waitMs !== null) return waitsUsed >= PACED_RE_ASKS ? null : f.waitMs;
  if (tryIndex + 1 >= tries) return null;
  return START_RETRY_WAITS_MS[tryIndex] ?? null;
}

/**
 * The sentence shown when this press of Start is finished with.
 *
 * A gateway reason always maps to its own plain sentence. A call that opened and died is
 * the one case where the app has already done something about it, so it gets the sentence
 * that says so. Nothing here can return the engine's own words.
 */
export function startFailureMessage(f: StartFailure): string {
  return endReasonMessage(f.reason ?? (f.stage === "engine" ? "engine_no_answer" : null));
}
