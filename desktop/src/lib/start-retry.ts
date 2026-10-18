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
      waitMs,
    };
  }
  return { retryable: needsVideo, stage: needsVideo ? "engine" : "voice", detail, sessionId, waitMs: null };
}

/**
 * How long to wait before ask number tryIndex+2, or null when this press is over.
 *
 * A call that never showed a frame is not billed, so a repeat costs the account nothing
 * but a few seconds of waiting — which is still cheaper than the "cannot start" message.
 * When the server announced a wait, its number is used, once.
 */
export function startRetryWaitMs(f: StartFailure, tryIndex: number): number | null {
  if (!f.retryable) return null;
  if (f.waitMs !== null) return tryIndex < PACED_RE_ASKS ? f.waitMs : null;
  if (tryIndex + 1 >= START_TRIES) return null;
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
