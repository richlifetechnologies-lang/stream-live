// Offline proof for the sentence a customer reads when his picture never arrives.
//
// Run with:  node node_modules/esbuild/bin/esbuild --bundle --platform=node --format=cjs
//            scripts/check-no-picture.ts | node
//
// Nothing here touches the gateway, the camera or a minute of anyone's balance. The point is
// that a cause may only be claimed when this machine actually saw it, and that the words the
// customer gets name no service and no stack.
import { noPictureCause, noPictureDetail, type NoPictureEvidence } from "../src/lib/no-picture-cause";
import { endReasonMessage } from "../src/lib/end-reason";
import { START_RETRY_WAITS_MS, START_TRIES, classifyStartFailure, startFailureMessage, startRetryWaitMs } from "../src/lib/start-retry";

const fail: string[] = [];
const ok = (label: string, cond: boolean) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) fail.push(label);
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, String(got) === String(want));

const E = (cameraSeen: boolean, cameraProducing: boolean, connected: boolean): NoPictureEvidence =>
  ({ cameraSeen, cameraProducing, connected });

// ── The causes, and the order they are claimed in ────────────────────────────
eq("a camera that fed nothing is blamed first",
  noPictureCause(E(true, false, false)), "camera_stalled");
eq("a camera that fed nothing, on a line that did come up",
  noPictureCause(E(true, false, true)), "camera_stalled");
eq("no camera reading and no connection: the connection is the story",
  noPictureCause(E(false, false, false)), "never_connected");
eq("no camera reading, connection up: the honest remainder",
  noPictureCause(E(false, false, true)), "picture_hold");
eq("a feeding camera and a live connection: nothing is invented",
  noPictureCause(E(true, true, true)), "picture_hold");
// The one mistake this cannot be allowed to make: telling a man to go and poke a working
// webcam because the app never got a reading off it.
ok("an unread camera is never blamed",
  noPictureCause(E(false, false, true)) !== "camera_stalled");

// ── The log line: every signal, and no provider ──────────────────────────────
const starved = noPictureDetail(E(true, false, true), "camera_stalled", " [machine clock 9 minutes ahead of real time]");
ok("the log carries the cause token the panel counts on", starved.includes("cause=camera_stalled"));
ok("the log says the camera fed nothing", starved.includes("camera fed no frame at all"));
ok("the log keeps the clock reading", starved.includes("machine clock 9 minutes ahead"));
const unread = noPictureDetail(E(false, true, false), "never_connected", "");
ok("an unread counter is written as unread, not as a stall", unread.includes("camera counter gave no reading"));
ok("and the connection is written as never coming up", unread.includes("no connection came up"));
for (const line of [starved, unread]) {
  ok(`no provider name in "${line.slice(0, 28)}…"`, !/\bfal\b|\bdecart\b|lucy|https?:\/\//i.test(line));
}

// ── The customer's sentence for each cause ───────────────────────────────────
const SAY: Record<string, string> = {
  camera_stalled: "Your camera stopped feeding pictures to the app, so there was nothing for the video service to turn into your AI picture, and the call was closed rather than left running blank. Nothing was used - your minutes are exactly where they were. Pick your camera again in the bar at the bottom of the page, or unplug it and plug it back in, then press Start again. If it holds for a couple of minutes first, that is the video line being released and it costs you nothing.",
  never_connected: "No connection came up between this computer and the video line, so nothing ever reached your screen. Nothing was used - your minutes are exactly where they were. This is nearly always something in the way on this machine: switch off a VPN, let the app through your firewall, or try a different network, then press Start again. If it holds for a couple of minutes first, that is the video line being released and it costs you nothing.",
  picture_hold: "No picture arrived, so the app ended your call instead of letting it run. Nothing was used - your minutes are exactly where they were. This computer has to wait about two minutes for the video line to release before its next call, and the Start button is counting that time down. Press it again when it reaches zero; starting sooner only gets refused.",
};
for (const cause of Object.keys(SAY)) {
  const said = endReasonMessage(cause);
  eq(`${cause} says its own sentence`, said, SAY[cause]);
  ok(`${cause} never falls back to the generic line`, !said.includes("Something went wrong"));
  ok(`${cause} says he was not charged`, /Nothing was used/.test(said));
  ok(`${cause} names no provider and no stack`, !/\bfal\b|\bdecart\b|SQLSTATE|\bat \w+\.\w+|https?:\/\//i.test(said));
}
// The two new ones must not promise a countdown the screen may not be showing, because the
// ask that dies on the way there never arms one.
ok("the camera sentence describes the wait instead of counting it", !SAY.camera_stalled.includes("counting"));
ok("the network sentence does the same", !SAY.never_connected.includes("counting"));

// ── A cause changes the words, never the ladder ──────────────────────────────
const blindAsk = classifyStartFailure(null, "Stream Live: connection timed out", "sess-9", null, "fal", "never_connected");
eq("still an engine death", blindAsk.stage, "engine");
eq("still worth asking again", blindAsk.retryable, true);
const waits: number[] = [];
for (let i = 0; i < START_TRIES; i++) {
  const w = startRetryWaitMs(blindAsk, i);
  if (w !== null) waits.push(w);
}
eq("with the same waits as before", waits.join("+"), START_RETRY_WAITS_MS.join("+"));
ok("and the customer is told which side of the cable to look at",
  startFailureMessage(blindAsk).startsWith("No connection came up between this computer"));

// A gateway refusal is more specific than anything this machine can infer, so it still wins.
const refused = classifyStartFailure("out_of_minutes", "gateway refused", null, null, "fal", "camera_stalled");
ok("a gateway reason outranks the machine's own read",
  startFailureMessage(refused) === endReasonMessage("out_of_minutes"));
// A death this machine cannot explain keeps the sentence it had.
const plain = classifyStartFailure(null, "Stream Live: connection closed (1006)", "sess-10", null, "fal", null);
ok("an unproved cause keeps the old sentence",
  startFailureMessage(plain) === endReasonMessage("engine_no_answer"));

console.log(fail.length ? `\nFAILED: ${fail.join(" | ")}` : "\nall no-picture cause rules pass");
process.exit(fail.length ? 1 : 0);
