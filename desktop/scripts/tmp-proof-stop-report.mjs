// Proof for v1.8.35: the app now says WHO closed a call, and the panel prints that answer
// instead of guessing at it. Two things have to be true and this script checks both:
//   1. a press on Stop is recorded as his hand, and nothing else is;
//   2. nothing in the money path moved, so the metering of a call is exactly as before.
// Run from the repo root:  node desktop/scripts/tmp-proof-stop-report.mjs
// STOP_SKIP_BUILT=1 skips the assertions over the built bundle (use it before the build).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = "C:/Users/david/Documents/Qoder/2026-09-23/c3f0b901/stream-live";
const D = ROOT + "/desktop";
// The paths are overridable so the same gates can be run against the PREVIOUS release's sources
// as a control: if a gate passes there too, it proves nothing.
const STREAM = process.env.STOP_STREAM || D + "/src/pages/stream.tsx";
const GW = process.env.STOP_GATEWAY || D + "/src/lib/gateway.ts";
const MIG = process.env.STOP_MIGRATION || ROOT + "/supabase/migrations/20261103200000_the_app_says_who_closed_the_call.sql";
const readOr = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const stream = readOr(STREAM);
const gateway = readOr(GW);
const mig = readOr(MIG);
// The file is wrapped for reading, so the checks below run against it with the line breaks evened out.
const migFlat = mig.replace(/\s+/g, " ");

const fail = [];
const ok = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) fail.push(label); };

// ─── 1. the writer: one column, two words, only his own call ─────────────────
ok("the migration adds only the one column",
  (migFlat.match(/alter table public\.usage_sessions add column/g) || []).length === 1 &&
  /add column if not exists stopped_by text;/.test(migFlat));
ok("that column can hold no other answer than user or app",
  /not in \('user', 'app'\) then return; end if/.test(migFlat));
ok("the writer is security definer and pinned to a search path",
  /security definer/.test(migFlat) && /set search_path = public, pg_temp/.test(migFlat));
ok("the writer only touches the caller's own session",
  /where id = p_session_id and user_id = auth\.uid\(\)/.test(migFlat));
ok("an account with no sign-in writes nothing",
  /if auth\.uid\(\) is null or p_session_id is null then return/.test(migFlat));
ok("anon is refused the writer outright",
  /revoke execute on function public\.sl_report_call_end\(uuid, text\) from public, anon/.test(migFlat));
ok("the migration writes no money column",
  !/billed_minutes|pending_debit|real_minutes|settled|multiplier/.test(mig.replace(/--[^\n]*/g, "")));

// ─── 2. the app's side of the call ──────────────────────────────────────────
const rpc = /export function reportCallEnd[\s\S]*?\n}/.exec(gateway);
ok("gateway.ts exports reportCallEnd", !!rpc);
ok("it names the database function, not a table",
  !!rpc && /rpc\("sl_report_call_end"/.test(rpc[0]) && !rpc[0].includes(".from("));
ok("it sends both halves of the answer",
  !!rpc && /p_session_id: sessionId/.test(rpc[0]) && /p_stopped_by: stoppedBy/.test(rpc[0]));
ok("it only accepts the two words the database accepts",
  !!rpc && /stoppedBy: "user" \| "app"/.test(rpc[0]));
ok("a call with no id says nothing", !!rpc && /if \(!sessionId\) return/.test(rpc[0]));
ok("the report never blocks or throws into the teardown",
  !!rpc && /\.then\(\(\) => undefined, \(\) => undefined\)/.test(rpc[0]));

// The report has to come before anything that can throw, or the answer is lost with the rest.
const teardown = /const teardownStream = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[/.exec(stream);
ok("teardownStream found", !!teardown);
const td = teardown ? teardown[0] : "";
const atReport = td.indexOf("reportCallEnd(");
const atEndLease = td.indexOf("endLease()");
const atFirstClose = td.indexOf("videoSessionRef.current?.close()");
ok("the who-closed answer is sent during teardown", atReport > -1);
ok("it is sent before the lease is closed", atReport > -1 && atEndLease > -1 && atReport < atEndLease);
ok("it is sent before the video line is shut, which is the step that can throw",
  atReport > -1 && atFirstClose > -1 && atReport < atFirstClose);
ok("it is read from the session ref, which still holds the id at that point",
  /reportCallEnd\(sessionIdRef\.current, /.test(td));
ok("the flag is cleared in the same breath, so the next teardown starts clean",
  /reportCallEnd\(sessionIdRef\.current, stoppedByHandRef\.current \? "user" : "app"\);\s*\n\s*stoppedByHandRef\.current = false;/.test(td));

// Every way his hand reaches the Stop control must light the flag; nothing else may.
const stopLine = /const handleStop = useCallback\(\(\) => \{([^}]*)\}/.exec(stream);
ok("pressing Stop marks his hand and then tears down",
  !!stopLine && /stoppedByHandRef\.current = true;/.test(stopLine[1]) && /teardownStream\(\)/.test(stopLine[1]));
ok("the Stop button on the picture popout counts as his hand too",
  /"stream-live-stop"\) \{ stoppedByHandRef\.current = true; teardownStream\(\); \}/.test(stream));
ok("walking to another tab mid-call counts as his hand",
  (() => { const m = /const switchTab = useCallback\(\(tab: TabId\) => \{[\s\S]*?\n  \}, \[/.exec(stream);
    return !!m && /if \(isStreaming \|\| isStarting\) \{\s*\n\s*stoppedByHandRef\.current = true;\s*\n\s*teardownStream\(\);/.test(m[0]); })());
const esc = /const k = \(e: KeyboardEvent\) => \{[\s\S]*?\n  \};/.exec(stream);
ok("Escape over a call counts as his hand",
  !!esc && (esc[0].match(/stoppedByHandRef\.current = true; teardownStream\(\)/g) || []).length === 2);
ok("a transport that came back and asked for its call is NOT his hand",
  (() => { const m = /"stream-live-reconnect"[\s\S]*?\n      \}/.exec(stream);
    return !!m && !m[0].includes("stoppedByHandRef"); })());

// A new call must not inherit the last call's answer.
ok("the flag is declared once, as a ref",
  (stream.match(/const stoppedByHandRef = useRef\(false\)/g) || []).length === 1);
ok("a fresh lease resets the flag with the other per-call signals",
  /paintedRef\.current\s*=\s*false;\s*\n\s*stoppedByHandRef\.current = false;/.test(stream));

// ─── 3. the money path did not move ─────────────────────────────────────────
// The honest test is not "which lines changed" but "is every metering step still there, the same
// number of times, in the same file". A line that was only re-written to add one word shows up
// here as unchanged.
const countIn = (src, needle) => src.split(needle).length - 1;
const atHead = (path) => { try {
  return execFileSync("git", ["show", "HEAD:" + path], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch { return null; } };
if (!process.env.STOP_SKIP_DIFF) {
  const headStream = atHead("desktop/src/pages/stream.tsx");
  const headGateway = atHead("desktop/src/lib/gateway.ts");
  ok("the previous release's sources were read for comparison", headStream !== null && headGateway !== null);
  for (const step of ["beginLease(", "updateLease(", "endLease(", "markMedia(", "reportCallFailure(",
                      "sl_report_call_failure", "billed", "settle"]) {
    const before = headStream === null ? -1 : countIn(headStream, step);
    const now = countIn(stream, step);
    ok(`the metering step "${step}" still appears ${now} time(s) in the page`, before === now && now >= 0);
    const gBefore = headGateway === null ? -1 : countIn(headGateway, step);
    const gNow = countIn(gateway, step);
    ok(`the metering step "${step}" still appears ${gNow} time(s) in the gateway`, gBefore === gNow);
  }

  const diff = (() => { try {
    return execFileSync("git", ["diff", "-U0", "--", "desktop/src/pages/stream.tsx", "desktop/src/lib/gateway.ts"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch { return ""; } })();
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  const inertLines = new Set((rpc ? rpc[0] : "").split("\n").map((l) => l.trim()));
  const inert = (l) => { const t = l.trim(); return t === "" || inertLines.has(t) ||
    t.includes("stoppedByHandRef") || t.includes("reportCallEnd") ||
    t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") ||
    t.startsWith("import { gateway, deviceId,"); };
  const offenders = added.filter((l) => !inert(l));
  ok(`every line the app gained is about who closed the call (${added.length} lines, ${offenders.length} out of place)`,
    offenders.length === 0);
  offenders.forEach((l) => console.log("      out of place: " + l.trim()));
  ok("the added lines are few enough to read", added.length <= 45);
}

// ─── 4. the built bundle carries the report ─────────────────────────────────
if (!process.env.STOP_SKIP_BUILT) {
  const chunks = [];
  for (const d of [D + "/dist/assets", D + "/dist"]) {
    let entries;
    try { if (!statSync(d).isDirectory()) continue; entries = readdirSync(d); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith(".js")) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory() || chunks.some((c) => c.p === p)) continue;
      chunks.push(readFileSync(p, "utf8"));
    }
  }
  const all = chunks.join("\n");
  ok(`the built renderer has chunks (${chunks.length})`, chunks.length >= 1);
  ok("the built renderer calls the new database function by name", all.includes("sl_report_call_end"));
  ok("the built renderer still calls the old failure writer", all.includes("sl_report_call_failure"));
}

console.log(fail.length ? `\n${fail.length} FAILURES` : "\nall checks passed");
if (fail.length) { fail.forEach((f) => console.log("  - " + f)); process.exit(1); }
