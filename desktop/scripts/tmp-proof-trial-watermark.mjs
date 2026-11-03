// v1.8.32 proof: the trial's watermark is said twice - a card once per machine, then a ribbon
// that stays for every trial call - and neither appears for an account that has minutes.
// Run from the repo root: node desktop/scripts/tmp-proof-trial-watermark.mjs
import { readFileSync, existsSync } from "node:fs";

let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? ": " + extra : ""));
  if (!cond) fails++;
};

const STREAM = readFileSync("desktop/src/pages/stream.tsx", "utf8");
const LADDER = readFileSync("desktop/src/lib/start-retry.ts", "utf8");
const OFFER  = readFileSync("desktop/src/components/watermark-offer.tsx", "utf8");

const KEYS = [
  "Trial minutes carry a watermark",
  "Paid minutes carry none.",
  "Paid minutes carry none — the mark is gone the moment minutes are in your account.",
  "This call is on your free trial, so a mark sits on the AI picture. It is the only thing the trial limits. Your picture is arriving behind this — close it when you have read it.",
  "Close",
];

// ── the gate: who sees it ────────────────────────────────────────────────────
const gate = /!account\.paid && activeTab !== "audio-only" && !trialRibbonOff && \(isStarting \|\| isStreaming\)/;
ok("the ribbon is gated on an unpaid account, a picture tab, and a call in progress", gate.test(STREAM));
ok("the card is gated on the same unpaid account", /if \(!account\.paid && tabName !== "audio-only"\) \{/.test(STREAM));
ok("a control that is not dismissed is not invented: the ribbon has its own x",
   /onClick=\{\(\) => setTrialRibbonOff\(true\)\}/.test(STREAM));
ok("the card's Close is the only way out of the card", /onClick=\{\(\) => setTrialCard\(false\)\}/.test(STREAM));

// ── the timing: once per machine, then every trial call ──────────────────────
ok("the machine is marked before the card is shown, so it cannot repeat",
   STREAM.indexOf('localStorage.setItem(TRIAL_CARD_SEEN, "1")') < STREAM.indexOf("setTrialCard(true)"));
ok("the card flag is read before it is written",
   /seen = localStorage\.getItem\(TRIAL_CARD_SEEN\)/.test(STREAM) && /if \(!seen\)/.test(STREAM));
ok("every new trial call brings the ribbon back",
   /setTrialRibbonOff\(false\);/.test(STREAM));
ok("the card never outlives the call it was about",
   /if \(!isStarting && !isStreaming && connStatus === "idle"\) setTrialCard\(false\);/.test(STREAM));
ok("the voice-only tab is not promised a picture it does not send",
   (STREAM.match(/!== "audio-only"/g) || []).length >= 2);

// ── what it says ─────────────────────────────────────────────────────────────
ok("the card names the trial, not a provider", !/fal|decart|lucy/i.test(KEYS.join(" ")));
ok("the standing sentence is the trial's own limitation, in the app's own words",
   /It is the only thing the trial limits/.test(KEYS.join(" ")));
ok("the ribbon says where the mark goes away", /the moment minutes are in your account/.test(KEYS.join(" ")));
ok("the offer card that already said this is still on the page", /WatermarkOffer/.test(STREAM));

// ── five languages carry every new line ──────────────────────────────────────
for (const [code, file] of [["es", "i18n-es.ts"], ["fr", "i18n-fr.ts"], ["pt", "i18n-pt.ts"], ["ar", "i18n-ar.ts"]]) {
  const src = readFileSync("desktop/src/lib/" + file, "utf8");
  for (const key of KEYS) {
    const line = src.split("\n").find((l) => l.trim().startsWith('"' + key.replace(/"/g, '\\"') + '":'));
    const value = line ? line.slice(line.indexOf('": "') + 4).replace(/",?\s*$/, "") : "";
    ok(code + " answers “" + key.slice(0, 34) + (key.length > 34 ? "…" : "") + "”",
       !!value && value !== key, value ? "" : "no line at all");
  }
}

// ── the treatment did not change ─────────────────────────────────────────────
ok("the retry ladder is still three asks", /START_TRIES\s*=\s*3/.test(LADDER));
ok("with the same two waits", /\[10_000,\s*30_000\]/.test(LADDER));
const cardBlock  = STREAM.slice(STREAM.indexOf("{trialCard && ("), STREAM.indexOf("{/* Fullscreen overlay */}"));
const ribbonBlock = STREAM.slice(STREAM.indexOf("{!account.paid && activeTab"), STREAM.indexOf("{/* OBS / popout"));
ok("the popup never sells: the card and the ribbon hold no route to the till",
   cardBlock.length > 400 && ribbonBlock.length > 400
   && !/setLocation|gateway\.|beginLease/.test(cardBlock) && !/setLocation|gateway\.|beginLease/.test(ribbonBlock));
ok("and the card holds exactly one control, its Close",
   (cardBlock.match(/onClick=/g) || []).length === 1);
ok("and the ribbon holds exactly one control, its x",
   (ribbonBlock.match(/onClick=/g) || []).length === 1);

// ── the built page carries it, when a build has run ──────────────────────────
// desktop/dist, not dist: this proof runs from the repo root like the other language proofs.
// TRIAL_SKIP_BUILT=1 is for the pre-build gate: at that point desktop/dist still holds the
// PREVIOUS release, and saying "the old bundle has no new sentence" is true but tells us nothing.
const assets = (process.env.TRIAL_SKIP_BUILT === "1" || !existsSync("desktop/dist/assets"))
  ? "" : readFileSync("desktop/dist/index.html", "utf8");
if (assets) {
  // vite writes src="./assets/index-xxxx.js" - a pattern demanding a leading slash matches nothing,
  // and an empty bundle read reports the shipped sentences as missing.
  const js = (assets.match(/src="\.?\/assets\/[^"]+\.js"/g) || [])
    .map((m) => m.slice(6, -1).replace(/^\.?\//, ""))
    .map((p) => readFileSync("desktop/dist/" + p, "utf8")).join("\n");
  ok("the built page names the entry script it loads", js.length > 100000, js.length + " chars read");
  ok("the built bundle ships the card's sentence", js.includes("Trial minutes carry a watermark"));
  ok("and the ribbon's", js.includes("the mark is gone the moment minutes are in your account"));
  ok("and the sentence that says the picture is coming", js.includes("Your picture is arriving behind this"));
  ok("and the once-per-machine flag", js.includes("ss_trial_card_seen"));
  ok("in Spanish too", js.includes("Los minutos de prueba llevan marca de agua"));
  ok("and in Arabic", js.includes("الدقائق التجريبية تحمل علامة ماء"));
  ok("the voice-only tab is still excluded in the built page", /audio-only/.test(js));
} else {
  console.log("SKIP  the built-page checks (they run again after the vite build)");
}

console.log(fails ? "\n" + fails + " FAILURE(S)" : "\nall trial-watermark rules pass");
process.exit(fails ? 1 : 0);
