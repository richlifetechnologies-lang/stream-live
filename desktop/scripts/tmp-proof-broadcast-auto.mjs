// v1.8.33 proof: the two Broadcast to Calls switches come back on by themselves, are remembered on
// his machine, and never show a light for something the computer is not doing. Run from repo root:
//   node desktop/scripts/tmp-proof-broadcast-auto.mjs
// BROADCAST_SKIP_BUILT=1 is for the pre-build gate, when desktop/dist still holds the previous release.
import { readFileSync, existsSync } from "node:fs";

let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? ": " + extra : ""));
  if (!cond) fails++;
};

// This checkout is CRLF: a marker written with a bare \n matches nothing and the slice comes back
// empty, which reads as "the source lost the rule" when the proof simply could not see it.
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const SRC = read("desktop/src/pages/stream.tsx");

const between = (src, from, to) => {
  const a = src.indexOf(from);
  const b = to === null ? src.length : src.indexOf(to, a);
  return a < 0 || b < a ? "" : src.slice(a, b);
};

const CAM   = between(SRC, "const runVCam = useCallback", "const toggleVCam = useCallback");
const CAMBT = between(SRC, "const toggleVCam = useCallback", "// ─── Virtual microphone");
const ROUTE = between(SRC, "const applyAudioRoute = useCallback", "const toggleAudioRoute = useCallback");
const MICBT = between(SRC, "const toggleAudioRoute = useCallback", "// The panel comes back on its own");
const AUTO  = between(SRC, "// The panel comes back on its own", "// Re-apply routing when the AI output");
const ROW   = between(SRC, "const renderVirtualDevices", "const renderBroadcastGuide");
const START = between(SRC, "A voice-only call exists to put the cloned voice on the software microphone", "await runStartLadder(activeTab");

// ── 1. both switches are remembered on his machine, and on is the default ─────
ok("the picture switch opens in whatever this machine last left it, on unless he said off",
   /const \[vcamEnabled, setVcamEnabled\]\s*=\s*useState<boolean>\(\(\) => \{\n\s*try \{ return localStorage\.getItem\("ss_vcam_on"\) !== "0"; \} catch \{ return true; \}/.test(SRC));
ok("the voice switch likewise",
   /const \[audioRouteOn, setAudioRouteOn\]\s*=\s*useState<boolean>\(\(\) => \{\n\s*try \{ return localStorage\.getItem\("ss_mic_route_on"\) !== "0"; \} catch \{ return true; \}/.test(SRC));
ok("and a machine that has never been asked is on, so he presses nothing the first time",
   !/const \[(vcamEnabled|audioRouteOn)[^\n]*useState\(false\)/.test(SRC) &&
   /const \[vcamReady, setVcamReady\]\s*=\s*useState\(false\)/.test(SRC));

// ── 2. only his own press remembers a position ───────────────────────────────
ok("the picture record is written in exactly one place",
   (SRC.match(/setItem\("ss_vcam_on"/g) || []).length === 1);
ok("the voice record is written in exactly one place",
   (SRC.match(/setItem\("ss_mic_route_on"/g) || []).length === 1);
ok("and both places are his press, not the automatic pass",
   /localStorage\.setItem\("ss_vcam_on"/.test(CAMBT) && /localStorage\.setItem\("ss_mic_route_on"/.test(MICBT));
ok("the automatic pass writes nothing, so a computer that cannot do it cannot switch him off",
   !/setItem/.test(AUTO));
ok("his press still turns a switch off, and off stays off",
   /const next = !vcamEnabled;/.test(CAMBT) && /const next = !audioRouteOn;/.test(MICBT));

// ── 3. the automatic pass ────────────────────────────────────────────────────
ok("the panel puts itself back on when the page opens",
   /if \(on\) void runVCam\(true, true\);/.test(AUTO) && /if \(route\) void applyAudioRoute\(true, true\);/.test(AUTO));
ok("it does that once per visit, not again every time a device list moves",
   /if \(broadcastAutoRef\.current\) return;/.test(AUTO) && /broadcastAutoRef\.current = true;/.test(AUTO));
ok("it asks the machine for both positions before obeying them",
   /localStorage\.getItem\("ss_vcam_on"\) !== "0"/.test(AUTO) && /localStorage\.getItem\("ss_mic_route_on"\) !== "0"/.test(AUTO));
ok("a machine with nowhere to remember still gets the automatic pass",
   /catch \{ on = true; route = true; \}/.test(AUTO));
ok("the pass says nothing in a popup - the line under the switch carries the truth instead",
   !/toast\(/.test(AUTO));

// ── 4. a light never lies ───────────────────────────────────────────────────
ok("the picture pass takes the switch off when the driver will not start",
   /if \(!r\.supported\) \{[\s\S]{0,220}?setVcamEnabled\(false\);/.test(CAM));
ok("and off when this build has no camera layer at all",
   /if \(!api\?\.vcamStart \|\| !api\?\.vcamStop\) \{\n\s*setVcamSupported\(false\);/.test(CAM));
ok("the voice pass takes the switch off and records why, when no cable is visible",
   /setAudioRouteOn\(false\); setBroadcastBlocked\("no-cable"\); return;/.test(ROUTE));
ok("and when the runtime cannot pick an output device at all",
   /setAudioRouteOn\(false\); setBroadcastBlocked\("no-sink"\); return;/.test(ROUTE));
ok("a switch that is genuinely off after a press still reads the plain Off he knows",
   /: t\("Off — nothing reaches the cable"\)/.test(ROW));
ok("a switch the automatic pass could not deliver says what stopped it",
   /broadcastBlocked === "no-cable" \? t\("Virtual microphone not detected"\)/.test(ROW) &&
   /broadcastBlocked === "no-sink" \? t\("This runtime can't select an output device\."\)/.test(ROW));
ok("a route that does come up clears the reason away",
   (ROUTE.match(/setBroadcastBlocked\(""\)/g) || []).length === 3);
ok("off by his press clears it too",
   /if \(!next\) setBroadcastBlocked\(""\);/.test(MICBT));

// ── 5. his press keeps the loud answer it always had ─────────────────────────
ok("a press that cannot reach the cable still tells him in a popup, as it did",
   /if \(!auto\) toast\(\{ title: t\("Audio routing unsupported"/.test(ROUTE) && /if \(!auto\) toast\(\{\n\s*title: t\("Virtual microphone not detected"\)/.test(ROUTE));
ok("and a press that cannot start the camera still tells him",
   (CAM.match(/if \(!auto\) toast/g) || []).length === 3 && !/\n\s*toast\(/.test(CAM));
ok("the automatic pass fires no popup, only the press does",
   /if \(!auto\)/.test(CAM) && /applyAudioRoute\(next\);/.test(MICBT));
ok("the button still uses the same route, with the popup turned on for it",
   /await applyAudioRoute\(next\);/.test(MICBT));

// ── 6. nothing that was already true is lost ────────────────────────────────
ok("Start on a voice tab still switches the cable on for him, and does not remember it",
   /if \(voiceTab && !audioRouteOn\) \{ setAudioRouteOn\(true\); await applyAudioRoute\(true\); \}/.test(START) && !/setItem/.test(START));
ok("leaving the page still hands the camera driver back",
   /useEffect\(\(\) => \(\) => \{ stopVCamPump\(\); getElectronAPI\(\)\?\.vcamStop\?\.\(\); \}/.test(SRC));
ok("the ready-poll still runs while the picture is out",
   /if \(!vcamEnabled\) return;\n\s*let alive = true;/.test(SRC));
ok("the pinned audio output is still remembered the same way it was",
   /localStorage\.setItem\("ss_audio_sink", id\)/.test(SRC));
ok("the microphone switch and its label are still one row he can press",
   /toggleBtn\(audioRouteOn, toggleAudioRoute, false, "Toggle Stream Live Microphone"\)/.test(ROW) &&
   /toggleBtn\(vcamEnabled, toggleVCam, false, "Toggle Stream Live Camera"\)/.test(ROW));

// ── 7. both sentences the panel can now show already exist in all five languages ─
for (const [file, name] of [["i18n-es.ts", "Spanish"], ["i18n-pt.ts", "Portuguese"], ["i18n-fr.ts", "French"], ["i18n-ar.ts", "Arabic"]]) {
  const p = "desktop/src/lib/" + file;
  if (!existsSync(p)) { ok(name + " strings file", false, "missing"); continue; }
  const T = read(p);
  ok(name + " already carries both lines the switch can show",
     /"Virtual microphone not detected":\s*"[^"]+"/.test(T) && /"This runtime can't select an output device\.":\s*"[^"]+"/.test(T));
}
ok("this release invents no new sentence for the panel",
   !/t\("[^"]*(auto|automatically|restored)[^"]*"\)/.test(ROW));

// ── 8. the built bundle really carries the two records ──────────────────────
if (!process.env.BROADCAST_SKIP_BUILT) {
  const dir = "desktop/dist/assets";
  const { readdirSync } = await import("node:fs");
  const bundle = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith(".js")).map(f => read(dir + "/" + f)).join("\n")
    : "";
  ok("the packaged app carries the picture record", bundle.includes("ss_vcam_on"));
  ok("the packaged app carries the voice record", bundle.includes("ss_mic_route_on"));
}

console.log(fails === 0 ? "\nBROADCAST-AUTO PROOF CLEAN" : "\nBROADCAST-AUTO PROOF FAILED: " + fails);
process.exit(fails === 0 ? 0 : 1);
