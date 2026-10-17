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
 * Measured on this gateway over 30 days, on the calls that followed another call by the
 * same account: 85% of those started inside a minute never showed a picture, and the
 * figure only falls to about 65% once the gap passes five minutes. Waiting therefore
 * helps at the margin and is not the cure — the retry is here because a paid call that
 * never delivered a frame costs nothing, so a second and third ask are free attempts at a
 * result the customer wants. The waits are kept short for that reason: a press that
 * spends a minute and a half on retries of something broken is worse than one that says
 * so honestly in twenty seconds.
 */
export const START_TRIES = 3;
export const START_RETRY_WAITS_MS = [10_000, 30_000];

/** Why one ask failed, and whether asking again is the right answer to it. */
export type StartFailure = {
  retryable: boolean;
  stage: "gateway" | "engine" | "voice";
  detail: string;
  reason?: string;
  sessionId: string | null;
};

/**
 * What the gateway answered, sorted into the two kinds of refusal.
 *
 * pReason is a gateway reason code when the account itself was refused — no minutes, no
 * plan, wrong device, an old build. Those answers do not change by repeating, so they end
 * the press at once. Everything else is the video line taking the call and then not
 * producing a picture, which is exactly the failure a second ask cures.
 */
export function classifyStartFailure(pReason: string | null, needsVideo: boolean, detail: string, sessionId: string | null): StartFailure {
  if (pReason !== null) {
    return { retryable: pReason === "upstream_key", stage: "gateway", detail: `gateway refused (${pReason})`, reason: pReason, sessionId };
  }
  return { retryable: needsVideo, stage: needsVideo ? "engine" : "voice", detail, sessionId };
}

/**
 * How long to wait before ask number tryIndex+2, or null when this press is over.
 *
 * A call that never showed a frame is not billed, so a repeat costs the account nothing
 * but a few seconds of waiting — which is still cheaper than the "cannot start" message.
 */
export function startRetryWaitMs(f: StartFailure, tryIndex: number): number | null {
  if (!f.retryable) return null;
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
