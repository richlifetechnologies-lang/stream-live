// v1.8.34 proof: the two Broadcast to Calls switches are off, and the ONLY thing that lights them is
// a call of this tab's own opening; the same call ending - or him walking off a tab that holds no
// call - puts them back. Run from repo root:
//   node desktop/scripts/tmp-proof-broadcast-on-dial.mjs
// BROADCAST_SKIP_BUILT=1 is for the pre-build gate, when desktop/dist still holds the previous release.
// BROADCAST_SRC=<file> points the whole proof at another copy of stream.tsx, which is how the control
// run (the previous release's source) is shown to FAIL rather than to pass by accident.
import { readFileSync, existsSync } from "node:fs";

let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? ": " + extra : ""));
  if (!cond) fails++;
};

// This checkout is CRLF: a marker written with a bare \n matches nothing and the slice comes back
// empty, which reads as "the source lost the rule" when the proof simply could not see it.
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const SRC = read(process.env.BROADCAST_SRC || "desktop/src/pages/stream.tsx");

const between = (src, from, to) => {
  const a = src.indexOf(from);
  const b = to === null ? src.length : src.indexOf(to, a);
  return a < 0 || b < a ? "" : src.slice(a, b);
};

const DECL  = between(SRC, "// ── Virtual devices", "const [vcamSupported");
const CAM   = between(SRC, "const runVCam = useCallback", "const toggleVCam = useCallback");
const CAMBT = between(SRC, "const toggleVCam = useCallback", "// ─── Virtual microphone");
const ROUTE = between(SRC, "const applyAudioRoute = useCallback", "const toggleAudioRoute = useCallback");
const MICBT = between(SRC, "const toggleAudioRoute = useCallback", "// Put both of this tab's fake devices back");
const REL   = between(SRC, "// Put both of this tab's fake devices back", "// Re-apply routing when the AI output");
const TABSW = between(SRC, "const switchTab = useCallback", "}, [isStreaming, isStarting]);");
const DOWN  = between(SRC, "const teardownStream = useCallback", "  }, [releaseAirHold]);");
const DIAL  = between(SRC, "// The call is open: NOW this tab's switches light", "const t0 = Date.now();");

// ── 1. they start off, and nothing is remembered ─────────────────────────────
ok("the picture switch opens off on every tab",
   /const \[camOnTab, setCamOnTab\] = useState<Record<TabId, boolean>>\(\n\s*\{ "video-audio": false, "video-only": false, "audio-only": false \}\);/.test(DECL));
ok("the voice switch opens off on every tab",
   /const \[micOnTab, setMicOnTab\] = useState<Record<TabId, boolean>>\(\n\s*\{ "video-audio": false, "video-only": false, "audio-only": false \}\);/.test(DECL));
ok("no machine memory is read or written for either of them",
   !/ss_vcam_on/.test(SRC) && !/ss_mic_route_on/.test(SRC));
ok("the old once-per-visit automatic pass is gone",
   !/broadcastAutoRef/.test(SRC));

// ── 2. a switch belongs to ONE tab, not to the screen ────────────────────────
ok("what the panel shows is this tab's own record",
   /const vcamEnabled\s+= camOnTab\[activeTab\];/.test(DECL) && /const audioRouteOn = micOnTab\[activeTab\];/.test(DECL));
ok("every writer names the tab it means",
   /const setCamFor = useCallback\(\(tab: TabId, on: boolean\) => setCamOnTab\(p => \(\{ \.\.\.p, \[tab\]: on \}\)\), \[\]\);/.test(DECL) &&
   /const setMicFor = useCallback\(\(tab: TabId, on: boolean\) => setMicOnTab\(p => \(\{ \.\.\.p, \[tab\]: on \}\)\), \[\]\);/.test(DECL));
ok("there is no whole-screen setter left to light all three tabs at once",
   !/setVcamEnabled\(/.test(SRC) && !/setAudioRouteOn\(/.test(SRC));
ok("nothing else in the page touches the two records directly",
   (SRC.match(/setCamOnTab\(/g) || []).length === 1 && (SRC.match(/setMicOnTab\(/g) || []).length === 1);

// ── 3. a call opening is the only thing that lights them ─────────────────────
ok("the dial lights them, at the moment the line is open and the call is running",
   /broadcastOwnerRef\.current = activeTab;/.test(DIAL) &&
   /if \(!voiceOnly && !camOnTab\[activeTab\]\) await runVCam\(true, true, activeTab\);/.test(DIAL) &&
   /if \(!micOnTab\[activeTab\]\) \{ setMicFor\(activeTab, true\); await applyAudioRoute\(true, true, activeTab\); \}/.test(DIAL));
ok("and that happens after the call is proved open, not on the press that may still be refused",
   SRC.indexOf("broadcastOwnerRef.current = activeTab") > SRC.indexOf("gateway.beginHeartbeat"));
ok("a call with no picture to send lights the microphone only - Voice Clone Never gets a camera running",
   /if \(!voiceOnly && !camOnTab\[activeTab\]\)/.test(DIAL));
ok("the camera is started from exactly one place besides his own press",
   (SRC.match(/runVCam\(true, true/g) || []).length === 1);
ok("nothing at page open starts either device",
   !/runVCam\(true/.test(between(SRC, "// ─── Camera", "const runVCam = useCallback")));

// ── 4. the same call ending, or him leaving a tab, puts them back ────────────
ok("both devices are handed back together",
   /const releaseBroadcast = useCallback\(\(tab: TabId\): void => \{/.test(REL) &&
   /stopVCamPump\(\);/.test(REL) && /vcamStop\?\.\(\);/.test(REL) &&
   /setCamFor\(tab, false\);\n\s*setMicFor\(tab, false\);\n\s*void applyAudioRoute\(false, true, tab\);/.test(REL));
ok("the call ending releases the tab that dialled, whichever tab he is looking at by then",
   /releaseBroadcastRef\.current\(broadcastOwnerRef\.current\);/.test(DOWN));
ok("walking off a tab that holds no call puts its switches back too",
   /else \{/.test(TABSW) && /releaseBroadcastRef\.current\(activeTab\);/.test(TABSW));
ok("a cancel or a dead line during the hand-over leaves no switch lit",
   /if \(startCancelRef\.current \|\| sessionGenRef\.current !== genAtOpen\) releaseBroadcastRef\.current\(activeTab\);/.test(DIAL));
ok("teardownStream keeps ONE stable dependency list, so plugging in a webcam cannot end a live call",
   /useEffect\(\(\) => \{ return \(\) => \{ startCancelRef\.current = true; void teardownStream\(\); \}; \}, \[teardownStream\]\);/.test(SRC) &&
   !/releaseBroadcast[^\n]*\], \[releaseAirHold, /.test(SRC));
ok("it reaches the release through a ref, not through its own dependency list",
   /const releaseBroadcastRef = useRef<\(tab: TabId\) => void>\(\(\) => \{\}\);/.test(DECL) &&
   /useEffect\(\(\) => \{ releaseBroadcastRef\.current = releaseBroadcast; \}, \[releaseBroadcast\]\);/.test(SRC));

// ── 5. a light never lies ────────────────────────────────────────────────────
ok("the dial's own pass takes the switch off when the driver will not start",
   /if \(!r\.supported\) \{[\s\S]{0,240}?setCamFor\(tab, false\);/.test(CAM));
ok("and off when this build has no camera layer at all",
   /if \(!api\?\.vcamStart \|\| !api\?\.vcamStop\) \{\n\s*setVcamSupported\(false\);/.test(CAM));
ok("the voice pass takes the switch off and records why, when no cable is visible",
   /setMicFor\(tab, false\); setBroadcastBlocked\("no-cable"\); return;/.test(ROUTE));
ok("and when the runtime cannot pick an output device at all",
   /setMicFor\(tab, false\); setBroadcastBlocked\("no-sink"\); return;/.test(ROUTE));
ok("a tab with no camera of its own cannot keep the last tab's ready word",
   /if \(!vcamEnabled\) \{ setVcamReady\(false\); return; \}/.test(SRC));
ok("a switch that is genuinely off reads the plain Off he already knows",
   /: t\("Off — nothing reaches the cable"\)/.test(SRC));
ok("a switch the call could not deliver says what stopped it",
   /broadcastBlocked === "no-cable" \? t\("Virtual microphone not detected"\)/.test(SRC) &&
   /broadcastBlocked === "no-sink" \? t\("This runtime can't select an output device\."\)/.test(SRC));
ok("a route that does come up clears the reason away",
   (ROUTE.match(/setBroadcastBlocked\(""\)/g) || []).length === 3);

// ── 6. his own press still works, both ways, and remembers nothing ───────────
ok("the picture press flips this tab's switch and nothing else",
   /await runVCam\(!vcamEnabled, false, activeTab\);/.test(CAMBT));
ok("the voice press does the same",
   /const next = !audioRouteOn;\n\s*setMicFor\(activeTab, next\);/.test(MICBT) &&
   /await applyAudioRoute\(next, false, activeTab\);/.test(MICBT));
ok("neither press writes a record",
   !/setItem/.test(CAMBT) && !/setItem/.test(MICBT));
ok("a press that cannot reach the cable still tells him in a popup, as it always did",
   /if \(!auto\) toast\(\{ title: t\("Audio routing unsupported"/.test(ROUTE) &&
   /if \(!auto\) toast\(\{\n\s*title: t\("Virtual microphone not detected"\)/.test(ROUTE));
ok("the automatic passes that run with a live call fire no popup",
   (CAM.match(/if \(!auto\) toast/g) || []).length === 3);

// ── 7. nothing that was already true is lost ────────────────────────────────
ok("leaving the page still hands the camera driver back",
   /useEffect\(\(\) => \(\) => \{ stopVCamPump\(\); getElectronAPI\(\)\?\.vcamStop\?\.\(\); \}/.test(SRC));
ok("routing is re-applied when the picture reconnects, on the tab that holds it",
   /if \(audioRouteOn && connStatus === "connected"\) void applyAudioRoute\(true, true, activeTab\);/.test(SRC));
ok("the pinned audio output is still remembered the way it was",
   /localStorage\.setItem\("ss_audio_sink", id\)/.test(SRC));
ok("both rows are still there for him to press",
   /toggleBtn\(audioRouteOn, toggleAudioRoute, false, "Toggle Stream Live Microphone"\)/.test(SRC) &&
   /toggleBtn\(vcamEnabled, toggleVCam, false, "Toggle Stream Live Camera"\)/.test(SRC));

// ── 8. the one sentence this release rewrites exists in all five languages ───
const TOUR = "Your call switches this panel's camera on by itself, so the only thing you set is in your call app:";
const OLDTOUR = "Turn this panel's camera switch on";
const TOURSRC = read("desktop/src/components/guided-tour.tsx");
ok("the Windows walkthrough stop no longer tells him to flip a switch the call flips",
   !TOURSRC.includes(OLDTOUR) && TOURSRC.includes(TOUR));
for (const [file, name] of [["i18n-es.ts", "Spanish"], ["i18n-pt.ts", "Portuguese"], ["i18n-fr.ts", "French"], ["i18n-ar.ts", "Arabic"]]) {
  const p = "desktop/src/lib/" + file;
  if (!existsSync(p)) { ok(name + " strings file", false, "missing"); continue; }
  const T = read(p);
  ok(name + " already carries both lines the switch can show",
     /"Virtual microphone not detected":\s*"[^"]+"/.test(T) && /"This runtime can't select an output device\.":\s*"[^"]+"/.test(T));
  ok(name + " carries the rewritten walkthrough stop, and none of the old one",
     T.includes(TOUR) && !T.includes(OLDTOUR));
}

// ── 9. the built bundle really carries neither record ────────────────────────
if (!process.env.BROADCAST_SKIP_BUILT) {
  const dir = "desktop/dist/assets";
  const { readdirSync } = await import("node:fs");
  const bundle = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith(".js")).map(f => read(dir + "/" + f)).join("\n")
    : "";
  ok("the packaged app holds no picture record to restore at launch", !bundle.includes("ss_vcam_on"));
  ok("the packaged app holds no voice record to restore at launch", !bundle.includes("ss_mic_route_on"));
  ok("the packaged app still knows how to stop the driver when the call ends", bundle.includes("vcamStop"));
}

console.log(fails === 0 ? "\nBROADCAST-ON-DIAL PROOF CLEAN" : "\nBROADCAST-ON-DIAL PROOF FAILED: " + fails);
process.exit(fails === 0 ? 0 : 1);
