// Offline proof for the "Cannot start / Could not start the call. Please try again." fix:
// what one press of Start does when the video line takes the call and then dies, and what
// it does when the gateway answers "that machine's line is still being released, come back
// in N seconds" instead of handing out a pass that dies.
//
// Run with:  npx esbuild --bundle --platform=node --format=cjs  …  | node
// Nothing here touches the gateway, the camera or a minute of anyone's balance.
import {
  BLIND_RETRY_HOLD_MS, BLIND_RETRY_HOLD_SECONDS, PACED_WAIT_MAX_MS, PACED_WAIT_MIN_MS,
  PICTURE_GIVE_UP_MS,
  START_RETRY_WAITS_MS, START_TRIES,
  classifyStartFailure, preflightFailure, startFailureMessage, startRetryWaitMs,
} from "../src/lib/start-retry";

const fail: string[] = [];
const ok = (label: string, cond: boolean) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) fail.push(label);
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, String(got) === String(want));

// ── The complaint itself: a second call, right after the first one closed ──────
// The engine answers the gateway, hands out a token, and closes the line a few seconds
// later without ever sending a picture. 68 of the last 75 paid video failures on this
// gateway died inside eight seconds of that token, so the app never even reached its own
// thirty-second deadline.
const dead = classifyStartFailure(null, "Stream Live: connection closed (1006)", "sess-1");
eq("stage", dead.stage, "engine");
eq("carries the session for the record", dead.sessionId, "sess-1");
const waits: number[] = [];
for (let i = 0; i < START_TRIES; i++) {
  const w = startRetryWaitMs(dead, i);
  if (w !== null) waits.push(w);
}
eq("asks again instead of giving up", waits.length, START_TRIES - 1);
eq("waits", waits.join("+"), START_RETRY_WAITS_MS.join("+"));
ok("total wait stays inside two minutes", waits.reduce((a, b) => a + b, 0) < 120_000);

// ── The engine's own words must never reach the customer ───────────────────────
const words = startFailureMessage(dead);
ok("says the picture never arrived", /never produced a picture/.test(words));
ok("says nothing was used", /Nothing was used\./.test(words));
ok("no close code", !/1006/.test(words));
ok("no internal wording", !/Stream Live/.test(words));
ok("no address of any kind", !/:\/\//.test(words));

// ── The account's own refusals: repeating them only wastes his time ────────────
for (const reason of ["out_of_minutes", "modality_disabled", "no_subscription", "status_past_due",
                      "device_limit_reached", "device_revoked", "concurrent_limit", "not_entitled",
                      "maintenance", "update_required", "lines_busy"]) {
  const f = classifyStartFailure(reason, `gateway refused (${reason})`, null);
  eq(`${reason} is not repeated`, startRetryWaitMs(f, 0), null);
  const msg = startFailureMessage(f);
  ok(`${reason} gets its own sentence`, msg.length > 20 && msg !== "Something went wrong, so the call stopped. You weren't charged for it — please try again.");
}

// A gateway refusal that has no sentence must fall back, never leak the code.
eq("unmapped reason stays generic",
   startFailureMessage(classifyStartFailure("brand_new_code", "x", null)),
   "Something went wrong, so the call stopped. You weren't charged for it — please try again.");

// ── The two refusals that ARE worth asking about again ─────────────────────────
ok("the gateway blaming the video service is retried",
   startRetryWaitMs(classifyStartFailure("upstream_key", "x", "sess-2"), 0) === START_RETRY_WAITS_MS[0]);
// A failure on the voice side never reached the video line, so there is nothing a second
// ask could fix - and the app now knows that before it books anything.
ok("a voice-side failure is not retried",
   startRetryWaitMs(preflightFailure("mic_not_ready"), 0) === null);
eq("and the customer is told which part failed",
   /microphone/.test(startFailureMessage(preflightFailure("mic_not_ready"))), true);

// ── The paced refusal: the gateway measured this machine and announced a wait ──
// This is what sl_start_session answers a machine that pressed Start seconds after its last
// call, instead of handing out a pass that dies in six seconds. The wait is minutes long, and
// the customer has just been told to wait, so the app obeys the number by holding its own
// button - not by dialing again behind him.
const paced = classifyStartFailure("lines_busy", "gateway refused (lines_busy)", "sess-4", 47);
eq("the server's number is carried on the refusal", paced.waitMs, 47_000);
eq("the paced refusal still carries its session", paced.sessionId, "sess-4");
ok("asking again later is still the right answer", paced.retryable);
eq("but this press does not make that ask", startRetryWaitMs(paced, 0), null);
eq("nor does any later ask in it", startRetryWaitMs(paced, 1), null);

// ── The wait a blank call ends with ──────────────────────────────────────────
// The server's machine gate holds an address for 120 s, and for 240 s once three of its
// passes came out blank. The app's own hold is the longer of the two, so pressing Start when
// his countdown reaches zero is never refused: the wait he was shown is the whole wait.
eq("a blind call holds the machine for the server's longest hold", BLIND_RETRY_HOLD_MS, 240_000);
eq("which is the four minutes the sentence promises", BLIND_RETRY_HOLD_SECONDS, 240);
eq("and is the same ceiling an announced wait is capped at", PACED_WAIT_MAX_MS, BLIND_RETRY_HOLD_MS);
// The give-up has to land before the check-in that would close the call itself, or the
// customer watches the gateway do it and the engine has been running five seconds longer.
ok("the app gives up inside its own heartbeat interval", PICTURE_GIVE_UP_MS + 5_000 <= 45_000);
ok("and never so early that a slow first frame is called a failure", PICTURE_GIVE_UP_MS >= 30_000);

// Clamped at both ends: a one-second pause is not worth a screen, and an hour is not his day.
eq("a wait too short is raised", classifyStartFailure("lines_busy", "x", null, 1).waitMs, PACED_WAIT_MIN_MS);
eq("a wait too long is capped", classifyStartFailure("lines_busy", "x", null, 3600).waitMs, PACED_WAIT_MAX_MS);
eq("a fractional wait is counted in whole seconds", classifyStartFailure("lines_busy", "x", null, 12.6).waitMs, 13_000);

// Nobody announced anything, so nothing is held and the short ladder above still stands.
for (const none of [null, 0, -5, NaN]) {
  eq(`a refusal announcing ${String(none)} holds nothing`,
     classifyStartFailure("lines_busy", "x", null, none).waitMs, null);
}
// Only the gateway can pace a call. The video line dying by itself keeps the table above.
const engineWithNumber = classifyStartFailure(null, "connection closed (1006)", "sess-5", 90);
eq("an engine death ignores an announced wait", engineWithNumber.waitMs, null);
eq("and keeps the short ladder", startRetryWaitMs(engineWithNumber, 0), START_RETRY_WAITS_MS[0]);

// What he reads when even the paced ask fails: the server's seconds never become his words.
const pacedWords = startFailureMessage(paced);
ok("says the line is still being released", /still being released/.test(pacedWords));
ok("says nothing was used", /Nothing was used/.test(pacedWords));
ok("names no provider", !/\bfal\b|decart/i.test(pacedWords));
ok("quotes no number he was not given", !/47/.test(pacedWords));
ok("no internal wording", !/lines_busy|Stream Live/.test(pacedWords));

// ── The last ask ends the press, whatever it says ─────────────────────────────
eq("no fourth ask", startRetryWaitMs(dead, START_TRIES - 1), null);

console.log(fail.length ? `FAILED: ${fail.join(", ")}` : `all ${START_TRIES}-try start rules pass`);
process.exit(fail.length ? 1 : 0);
