// Offline proof for the sentence a customer reads when his picture never arrives.
//
// Run with:  node node_modules/esbuild/bin/esbuild --bundle --platform=node --format=cjs
//            scripts/check-no-picture.ts | node
//
// Nothing here touches the gateway, the camera or a minute of anyone's balance. The point is
// that a cause may only be claimed when this machine actually saw it, and that the words the
// customer gets name no service and no stack.
import { lineFullRefusal, noPictureCause, noPictureDetail, type NoPictureEvidence } from "../src/lib/no-picture-cause";
import { endReasonMessage } from "../src/lib/end-reason";
import { START_RETRY_WAITS_MS, START_TRIES, classifyStartFailure, startFailureMessage, startRetryWaitMs } from "../src/lib/start-retry";

const fail: string[] = [];
const ok = (label: string, cond: boolean) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) fail.push(label);
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, String(got) === String(want));

const E = (cameraSeen: boolean, cameraProducing: boolean, connected: boolean, lineAnswer = ""): NoPictureEvidence =>
  ({ cameraSeen, cameraProducing, connected, lineAnswer });

// The video service's own words, exactly as they came back on the dials of 2026-11-02 and
// 2026-11-03 that died three seconds after opening.
const AT_CAPACITY = "Stream Live error: Server at capacity. Please try again later.";
const SESSION_LIMIT = "Stream Live error: Concurrent session limit reached.";

// ── The causes, and the order they are claimed in ────────────────────────────
// A refusal at the door decides the case from the far side, so it is asked before anything
// this machine can see: his camera and his network were never involved.
eq("the service's own refusal outranks a starved camera",
  noPictureCause(E(true, false, false, SESSION_LIMIT)), "line_full");
eq("and outranks a connection that never came up",
  noPictureCause(E(false, false, false, AT_CAPACITY)), "line_full");
ok("both wordings are read as a full line",
  lineFullRefusal(SESSION_LIMIT) && lineFullRefusal(AT_CAPACITY));
ok("an ordinary timeout is not read as one",
  !lineFullRefusal("Stream Live: connection timed out"));
ok("and neither is a camera stall", !lineFullRefusal("camera produced no frame"));
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
// The refusal line is the one the panel counts as ours, so it has to carry the service's own
// words: a man hunting a capacity problem needs to see what was said, not just that it was said.
const refusedLine = noPictureDetail(E(false, false, false, SESSION_LIMIT), "line_full", "");
ok("the refusal is written with its own cause token", refusedLine.includes("cause=line_full"));
ok("and quotes what the service answered", refusedLine.includes("Concurrent session limit reached"));
for (const line of [starved, unread, refusedLine]) {
  ok(`no provider name in "${line.slice(0, 28)}…"`, !/\bfal\b|\bdecart\b|lucy|https?:\/\//i.test(line));
}

// ── The customer's sentence for each cause ───────────────────────────────────
const SAY: Record<string, string> = {
  camera_stalled: "Your camera stopped feeding pictures to the app, so there was nothing for the video service to turn into your AI picture, and the call was closed rather than left running blank. Nothing was used - your minutes are exactly where they were. Pick your camera again in the bar at the bottom of the page, or unplug it and plug it back in, then press Start again. If it holds for a couple of minutes first, that is the video line being released and it costs you nothing.",
  never_connected: "No connection came up between this computer and the video line, so nothing ever reached your screen. Nothing was used - your minutes are exactly where they were. This is nearly always something in the way on this machine: switch off a VPN, let the app through your firewall, or try a different network, then press Start again. If it holds for a couple of minutes first, that is the video line being released and it costs you nothing.",
  picture_hold: "No picture arrived, so the app ended your call instead of letting it run. Nothing was used - your minutes are exactly where they were. This computer has to wait about two minutes for the video line to release before its next call, and the Start button is counting that time down. Press it again when it reaches zero; starting sooner only gets refused.",
  line_full: "Our video line was full when you asked for it, so this call never opened. Nothing was used - your minutes are exactly where they were. There is nothing here for you to fix: it is our line, not your computer. Wait a couple of minutes and press Start again; if the button holds you for a short count-down first, that is the line being released and it costs you nothing.",
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
// The whole reason this cause exists: the sentence a refused dial used to get sent him to his
// own VPN, his firewall and his network, for a line that was full on our side.
ok("the full-line sentence sends him nowhere on his own machine",
  !/VPN|firewall|camera|network|wi-?fi/i.test(SAY.line_full));
ok("and names it as ours", /^Our video line was full/.test(SAY.line_full));

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

// A full line is a different cause, not a different treatment: the seller's own measurement is
// that the repeat tries are what gets a call through when the connection is simply not up yet,
// so naming the cause must never shorten the ladder.
const fullAsk = classifyStartFailure(null, SESSION_LIMIT, "sess-11", null, "fal", "line_full");
eq("a full line is still an engine death", fullAsk.stage, "engine");
eq("and still worth asking again", fullAsk.retryable, true);
const fullWaits: number[] = [];
for (let i = 0; i < START_TRIES; i++) {
  const w = startRetryWaitMs(fullAsk, i);
  if (w !== null) fullWaits.push(w);
}
eq("with exactly the same three asks and waits", fullWaits.join("+"), START_RETRY_WAITS_MS.join("+"));
ok("and the sentence he reads names our line",
  startFailureMessage(fullAsk).startsWith("Our video line was full"));

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
