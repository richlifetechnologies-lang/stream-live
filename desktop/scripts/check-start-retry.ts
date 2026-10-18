// Offline proof for the "Cannot start / Could not start the call. Please try again." fix:
// what one press of Start does when the video line takes the call and then dies, and what
// it does when the gateway answers "that machine's line is still being released, come back
// in N seconds" instead of handing out a pass that dies.
//
// Run with:  npx esbuild --bundle --platform=node --format=cjs  …  | node
// Nothing here touches the gateway, the camera or a minute of anyone's balance.
import {
  PACED_RE_ASKS, PACED_WAIT_MAX_MS, PACED_WAIT_MIN_MS,
  START_RETRY_WAITS_MS, START_TRIES,
  classifyStartFailure, startFailureMessage, startRetryWaitMs,
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
const dead = classifyStartFailure(null, true, "Stream Live: connection closed (1006)", "sess-1");
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
  const f = classifyStartFailure(reason, true, `gateway refused (${reason})`, null);
  eq(`${reason} is not repeated`, startRetryWaitMs(f, 0), null);
  const msg = startFailureMessage(f);
  ok(`${reason} gets its own sentence`, msg.length > 20 && msg !== "Something went wrong, so the call stopped. You weren't charged for it — please try again.");
}

// A gateway refusal that has no sentence must fall back, never leak the code.
eq("unmapped reason stays generic",
   startFailureMessage(classifyStartFailure("brand_new_code", true, "x", null)),
   "Something went wrong, so the call stopped. You weren't charged for it — please try again.");

// ── The two refusals that ARE worth asking about again ─────────────────────────
ok("the gateway blaming the video service is retried",
   startRetryWaitMs(classifyStartFailure("upstream_key", true, "x", "sess-2"), 0) === START_RETRY_WAITS_MS[0]);
ok("a voice-side failure is not retried",
   startRetryWaitMs(classifyStartFailure(null, false, "the voice service threw", "sess-3"), 0) === null);

// ── The paced refusal: the gateway measured this machine and announced a wait ──
// This is what sl_start_session now answers a machine that pressed Start seconds after
// its last call, instead of handing out a pass that dies in six seconds. The app's job is
// to obey that number once, not to argue with it.
const paced = classifyStartFailure("lines_busy", true, "gateway refused (lines_busy)", "sess-4", 47);
eq("an announced wait is worth asking again", paced.retryable, true);
eq("the wait is the server's own number", startRetryWaitMs(paced, 0), 47_000);
eq("and it is asked exactly once more", startRetryWaitMs(paced, 1), null);
eq("the paced refusal still carries its session", paced.sessionId, "sess-4");
eq("the paced press is one re-ask long", PACED_RE_ASKS, 1);

// Clamped at both ends: a one-second pause is not worth a screen, and an hour is not his day.
eq("a wait too short is raised", startRetryWaitMs(classifyStartFailure("lines_busy", true, "x", null, 1), 0), PACED_WAIT_MIN_MS);
eq("a wait too long is capped", startRetryWaitMs(classifyStartFailure("lines_busy", true, "x", null, 3600), 0), PACED_WAIT_MAX_MS);
eq("a fractional wait is counted in whole seconds", startRetryWaitMs(classifyStartFailure("lines_busy", true, "x", null, 12.6), 0), 13_000);

// Nobody announced anything, so the old rules still hold.
for (const none of [null, 0, -5, NaN]) {
  eq(`a refusal announcing ${String(none)} is not repeated`,
     startRetryWaitMs(classifyStartFailure("lines_busy", true, "x", null, none), 0), null);
}
// Only the gateway can pace a call. The video line dying by itself keeps the table above.
eq("an engine death ignores an announced wait",
   startRetryWaitMs(classifyStartFailure(null, true, "connection closed (1006)", "sess-5", 90), 0), START_RETRY_WAITS_MS[0]);

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
