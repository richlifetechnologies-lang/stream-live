// Offline proof for the "Cannot start / Could not start the call. Please try again." fix:
// what one press of Start does when the video line takes the call and then dies.
//
// Run with:  npx esbuild --bundle --platform=node --format=cjs  …  | node
// Nothing here touches the gateway, the camera or a minute of anyone's balance.
import { START_RETRY_WAITS_MS, START_TRIES, classifyStartFailure, startFailureMessage, startRetryWaitMs } from "../src/lib/start-retry";

const fail: string[] = [];
const ok = (label: string, cond: boolean) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) fail.push(label);
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, String(got) === String(want));

// ── The complaint itself: a second call, right after the first one closed ──────
// The engine answers the gateway, hands out a token, and closes the line a few seconds
// later without ever sending a picture. That is what killed 51 of 60 such calls.
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

// ── The last ask ends the press, whatever it says ─────────────────────────────
eq("no fourth ask", startRetryWaitMs(dead, START_TRIES - 1), null);

console.log(fail.length ? `FAILED: ${fail.join(", ")}` : `all ${START_TRIES}-try start rules pass`);
process.exit(fail.length ? 1 : 0);
