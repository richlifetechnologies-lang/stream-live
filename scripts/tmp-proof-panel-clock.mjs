// The clock strip said a rate you save is stamped by THIS machine, and that was false the day the
// server started dating rates itself. This proof pins the corrected rule down: the panel's own
// sentence, every window it reads, and every date it writes must all answer to the server's reading
// of now, and no browser clock may be used where a stored row is compared against "now".
//
//   node scripts/tmp-proof-panel-clock.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const panel = readFileSync(join(root, "supabase", "functions", "admin", "index.html"), "utf8");

const fails = [];
const ok = [];
const yes = (name, cond) => (cond ? ok : fails).push(name);

// 1. the retired sentence, and the one that replaces it
yes("the strip no longer claims a rate is stamped by this machine", !panel.includes("is stamped by THIS clock"));
yes("the strip no longer promises the server may not honour it", !panel.includes("the server may not honour it yet"));
yes("the strip no longer offers a rate box to type a time into", !panel.includes("whatever time you type into a rate box"));
yes("the strip says a saved rate is dated by the server the second you press Save",
  panel.includes("a burn rate you save is dated by the server the second you press Save"));
yes("the strip names the gap a fact about the PC, not about the figures",
  panel.includes("this gap changes no figure and starts no rate late"));
yes("the strip still prints the gap in minutes", panel.includes('Math.abs(skewMin).toFixed(0) + " minutes'));
yes("the unknown-clock branch admits a window is unmeasurable",
  panel.includes("cannot tell you what a"));

// 2. no window or stamp is taken off this machine's clock any more
const browserNow = [...panel.matchAll(/Date\.now\(\)\s*[-+]\s*([\d_ *e]+)/g)]
  .map((m) => m[0].replace(/\s+/g, " "));
yes("no 24-hour or multi-day window is still computed from Date.now()",
  !browserNow.some((s) => /864e5|86_400_000|3600000|3 \* 60000/.test(s)));
for (const [name, needle] of [
  ["the key-pool 24-hour window", 'const cutoff = new Date(serverNowMs() - 864e5).toISOString();\n    const { data, error } = await sb.from("key_usage_log")'],
  ["the refused-call 24-hour window", 'const cutoff = new Date(serverNowMs() - 864e5).toISOString();\n    const { data, error } = await sb.from("call_failures")'],
  ["the calls 3-day window", "const since = new Date(serverNowMs() - 3 * 86_400_000).toISOString();"],
  ["a payment's age label", "const m = Math.round((serverNowMs() - new Date(iso).getTime()) / 60000);"],
  ["the 24-hour duplicate-payment check", "serverNowMs() - new Date(recent.credited_at || recent.created_at).getTime() < 24 * 3600000"],
  ["the stale-pending order rule", "serverNowMs() - new Date(p.created_at).getTime() > 3 * 60000"],
  ["the engine pin's own stamp", "engine_override_at: serverNowIso()"],
  ["the Prices tab verified-on date", "last_verified_at: serverNowIso().slice(0, 10)"],
  ["every card's read-again stamp", '$(id).textContent = "read " + serverNowIso().slice(11, 19) + " UTC"'],
]) yes(name, panel.includes(needle));
yes("serverNowIso exists exactly once", (panel.match(/const serverNowIso = /g) || []).length === 1);

// 3. a window is never measured before the server's reading has arrived
yes("showDash waits for the clock measurement", /await CLOCK_READY;\s*\n\s*await loadPlans\(\);/.test(panel));
yes("the wait is on the real promise", panel.includes("const CLOCK_READY = syncClock();"));
yes("the panel never fires syncClock twice", (panel.match(/syncClock\(\)/g) || []).length === 3);

// 4. the refused-call card describes the new kind of row
yes("the card is titled for refusals and losses", panel.includes("Calls the app refused or lost — last 24 hours"));
yes("the card explains the mid-call row separately", panel.includes("<b>video line closed</b>"));
yes("the mid-call row is not marked as a refusal pill",
  panel.includes('r.stage === "gateway" || r.stage === "video line closed" ? "warn" : "fail"'));
yes("an empty card says refused or lost", panel.includes("No call has been refused or lost in the last 24 hours."));

// 5. the collision trap: one definition of each name this proof touches
for (const name of ["loadKeyUsage", "loadCallFailures", "loadSessions", "showDash", "paintClock", "syncClock", "serverNowMs", "serverNowIso", "payAgo", "payNeedsAttention"]) {
  const n = (panel.match(new RegExp(`(async function|function|const) ${name}\\b`, "g")) || []).length;
  yes(`${name} is defined once (found ${n})`, n === 1);
}

// 6. the sentence the app actually writes must be the sentence the card describes
const app = readFileSync(join(root, "desktop", "src", "pages", "stream.tsx"), "utf8");
yes("the app still closes the line under this exact stage name",
  app.includes('reportCallFailure(sessionId, "video line closed"') && panel.includes('r.stage === "video line closed"'));

console.log(ok.map((s) => "  PASS " + s).join("\n"));
if (fails.length) {
  console.log(fails.map((s) => "  FAIL " + s).join("\n"));
  console.log("<<<PANEL-CLOCK-PROOF-FAILED>>>");
  process.exit(1);
}
console.log("<<<PANEL-CLOCK-PROOF-OK>>> " + ok.length + " checks");
