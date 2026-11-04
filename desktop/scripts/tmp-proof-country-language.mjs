// v1.8.33 proof: the language the customer's own country suggests is applied when he signs in,
// and never over the language he chose for himself with the button. Run from the repo root:
//   node desktop/scripts/tmp-proof-country-language.mjs
// AUTO_SKIP_BUILT=1 is for the pre-build gate, when desktop/dist still holds the previous release.
import { readFileSync, existsSync, readdirSync } from "node:fs";

let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? ": " + extra : ""));
  if (!cond) fails++;
};

// This checkout is CRLF: a marker written with a bare \n matches nothing and the slice comes back
// empty, which reads as "the source lost the rule" when the proof simply could not see it.
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const I18N = read("desktop/src/lib/i18n.ts");
const MENU = read("desktop/src/components/lang-menu.tsx");
const GW   = read("desktop/src/lib/gateway.ts");
const APP  = read("desktop/src/App.tsx");
const CLI  = read("client/stream-live-client.ts");
const FN   = read("supabase/functions/account-language/index.ts");
const GEO  = read("supabase/functions/_shared/geo.ts");
const MIG  = "supabase/migrations/20261103120000_language_follows_the_country.sql";
const SQL  = existsSync(MIG) ? read(MIG) : "";

// A slice of a source file between two markers, so a rule is proved about the function that owns it.
const between = (src, from, to) => {
  const a = src.indexOf(from);
  const b = to === null ? src.length : src.indexOf(to, a);
  return a < 0 || b < a ? "" : src.slice(a, b);
};

// ── the two setters: who is allowed to change the language ────────────────────
ok("the manual button still exists and is the only thing that marks a choice",
   /const pick = \(code: LangCode\) => \{ setLang\(code\); setOpen\(false\); \};/.test(MENU));
ok("the button does not use the automatic route", !/setLangAuto/.test(MENU));
ok("his press writes the 'he chose' flag", /try \{ localStorage\.setItem\(CHOSEN_KEY, "1"\); \}/.test(I18N));
ok("the flag is written by one function only, the manual one",
   (I18N.match(/setItem\(CHOSEN_KEY/g) || []).length === 1);
const AUTO = between(I18N, "export function setLangAuto", "export function hasChosenLang");
ok("the automatic route refuses a man who has chosen", /if \(hasChosenLang\(\)\) return;/.test(AUTO));
ok("and the automatic route leaves no choice behind, so his next click still wins",
   !/setItem\(CHOSEN_KEY/.test(AUTO));
const MANUAL = between(I18N, "export function setLang(next: LangCode)", "/**\n * The automatic route");
ok("the manual route ignores the flag and obeys the press", !/hasChosenLang/.test(MANUAL));
ok("both routes go through one apply, so a change re-renders the tree either way",
   /apply\(next\);/.test(MANUAL) && /apply\(next\);/.test(AUTO));
ok("the language the app ends on is remembered on the machine",
   /localStorage\.setItem\(STORE_KEY, next\)/.test(I18N));
const DETECT = between(I18N, "function detect()", "let current: LangCode");
ok("a first-run default is not mistaken for his choice", !/setItem\(CHOSEN_KEY/.test(DETECT));
ok("the five languages are still exactly the five, none invented",
   (I18N.match(/code: "(en|es|pt|fr|ar)"/g) || []).length === 5);
ok("Arabic still flips the whole window right-to-left, however it was chosen",
   /document\.documentElement\.dir = lang === "ar" \? "rtl" : "ltr"/.test(APP) && /const lang = useLang\(\);/.test(APP));

// ── the sign-in hook ─────────────────────────────────────────────────────────
const HOOK = between(GW, "export async function applySuggestedLanguage", "export async function refreshBalances");
ok("an account that is not signed in is never asked about", /if \(!state\.signedIn \|\| !email\) return;/.test(HOOK));
ok("a machine with a chosen language is not even asked", /if \(hasChosenLang\(\)\) return;/.test(HOOK));
ok("the choice is checked before the network is touched",
   HOOK.indexOf("hasChosenLang") < HOOK.indexOf("accountLanguage"));
ok("one account is asked once per session, not every meter read",
   /if \(langAskedFor === email\) return;/.test(HOOK) && /langAskedFor = email;/.test(HOOK));
ok("an answer that is not one of the five is dropped, not applied",
   /if \(!lang \|\| !LANGS\.some\(l => l\.code === lang\)\) return;/.test(HOOK));
ok("only the automatic route receives the server's answer", /setLangAuto\(lang as LangCode\)/.test(HOOK));
ok("a failed look-up is swallowed: no banner, no change, no retry storm",
   /catch \(err\) \{/.test(HOOK) && !/throw/.test(HOOK));
const REFR = between(GW, "export async function refreshBalances", "/**\n * The payment window has come back");
ok("the reading that every sign-in path already makes is what triggers it",
   /void applySuggestedLanguage\(\);/.test(REFR));
ok("the trigger is at the end, after the balances have been put on screen",
   REFR.indexOf("setState({ error: plainReadError(err) })") < REFR.indexOf("void applySuggestedLanguage"));
ok("nothing else in the app asks the server for a language",
   (GW.match(/void applySuggestedLanguage\(\)/g) || []).length === 1
   && !/applySuggestedLanguage/.test(APP));
ok("signing out forgets the account, so the next person on this machine gets his own reading",
   /langAskedFor = null;/.test(between(GW, "export async function signOut", "export async function requestTopup")));

// ── the client route ─────────────────────────────────────────────────────────
ok("the app sends an empty body and trusts the answer's shape, not its presence",
   /invoke\("account-language", \{\}\)/.test(CLI) && /typeof res\.lang === "string" && res\.lang \? res\.lang : null/.test(CLI));

// ── the edge function ────────────────────────────────────────────────────────
ok("the route refuses anyone who is not signed in", /await requireUser\(req\)/.test(FN));
ok("the refusal is a 401 and it says nothing about a country", /status: 401/.test(FN));
ok("the refusal comes before any look-up", FN.indexOf("requireUser") < FN.indexOf("countryForCaller"));
ok("nothing the app posts is read for the address", !/req\.json\(\)|req\.formData\(\)|req\.text\(\)/.test(FN));
ok("a preflight is answered", /if \(req\.method === "OPTIONS"\) return preflight\(\);/.test(FN));
ok("the country is only ever mapped, never forced past the five",
   /LANGS\.includes\(got\) \? got : "en"/.test(FN));
ok("a look-up that fails answers nulls instead of an error",
   /ok: true, country, lang/.test(FN) && !/status: 5\d\d/.test(FN));
ok("the flag is written through the database's own first-writing-wins rule",
   /db\.rpc\("sl_note_network", \{ p_user: userId, p_ip: null, p_country: country \}\)/.test(FN));
ok("and the route never edits a profile row itself", !/from\("profiles"\)[\s\S]{0,80}\.update/.test(FN) && !/\.upsert\(/.test(FN));

// ── where the address comes from ─────────────────────────────────────────────
ok("the platform's own country header is tried first",
   GEO.indexOf("requestCountry(req)") < GEO.indexOf('from("profiles")'));
ok("an account that already has a flag keeps it and no look-up runs",
   /if \(\/\^\[A-Z\]\[A-Z\]\$\/\.test\(stored\)\) return stored;/.test(GEO));
ok("a private or carrier-NAT address is never sent to an outside service",
   /isPublicIp\(ip\) \? await countryOfAddress\(ip\) : null/.test(GEO));
ok("the outside look-up cannot hang the sign-in", /AbortSignal\.timeout\(2500\)/.test(GEO));
ok("one approved look-up host, over https",
   (GEO.match(/https:\/\/[a-z.]+\//g) || []).join("") === "https://ipwho.is/");
ok("a service that answers with an error body yields no country", /body\.success !== true/.test(GEO));
ok("an answer that is not two letters yields no country",
   /\/\^\[A-Z\]\[A-Z\]\$\/\.test\(cc\) \? cc : null/.test(GEO));

// ── the mapping, read out of the migration itself ────────────────────────────
ok("the migration exists", SQL.length > 0, SQL.length + " chars");
const arms = [...SQL.matchAll(/when upper\(p_country\) in \(([^)]*)\)\s*then '(\w\w)'/g)];
const map = new Map();
let doubleBooked = [];
for (const [, list, lang] of arms) {
  for (const c of [...list.matchAll(/'([A-Z]{2})'/g)].map(m => m[1])) {
    if (map.has(c) && map.get(c) !== lang) doubleBooked.push(c + ":" + map.get(c) + "/" + lang);
    map.set(c, lang);
  }
}
const suggests = (c) => map.get(c) ?? "en";
ok("the four languages the seller approved are each suggested by their own countries",
   suggests("ES") === "es" && suggests("BR") === "pt" && suggests("FR") === "fr" && suggests("EG") === "ar");
ok("Spanish is not limited to Spain", suggests("MX") === "es" && suggests("CO") === "es" && suggests("AR") === "es");
ok("Portuguese covers Brazil as well as Portugal", suggests("PT") === "pt" && suggests("BR") === "pt");
ok("Arabic is not limited to Egypt", ["SA", "MA", "DZ", "TN", "AE"].every(c => suggests(c) === "ar"));
ok("French covers the francophone countries the seller listed",
   ["CD", "SN", "CI", "CM", "HT", "ML", "MG"].every(c => suggests(c) === "fr"));
ok("Ghana stays English — the seller's own market is not re-worded", suggests("GH") === "en");
ok("every country not named stays English", ["US", "NG", "KE", "IN", "DE", "IT", "JP", "BE", "CA"].every(c => suggests(c) === "en"));
ok("no country is claimed by two languages", doubleBooked.length === 0, doubleBooked.join(" "));
ok("the answer is only ever one of the five", [...new Set([...map.values()])].every(l => "en es pt fr ar".split(" ").includes(l)),
   [...new Set([...map.values()])].join(","));
ok("a country the server never read is answered, not blanked", /when p_country is null then 'en'/.test(SQL));
ok("the mapping is a plain immutable SQL function — no table, no network",
   /language sql/.test(SQL) && /immutable/.test(SQL));
ok("it is dated like every other migration on this project",
   /^20261103\d{6}_language_follows_the_country\.sql$/.test(MIG.split("/").pop()));
ok("it is executable by a signed-in account and by the gateway",
   /grant execute on function public\.sl_lang_for_country\(text\) to authenticated, service_role/.test(SQL));

// A migration's own comments wrap at eighty characters and each line carries its "--", so a
// promised sentence is proved on the text with both removed, never on one source line.
const prose = SQL.replace(/^--\s?/gm, "").replace(/\n\s*/g, " ");
ok("it says in its own words that no money is read from a country",
   /Nothing about a price, a shelf, a package, a payment door, a wallet or which engine serves the call is read from country/.test(prose));

// ── what this change must NOT have moved ─────────────────────────────────────
ok("the new migration writes no row and changes no table",
   !/update |insert into|delete from|alter table|create table/i.test(SQL));
ok("it does not redefine the network-note rule it relies on", !/sl_note_network/.test(SQL));
ok("the comment on the column-less function repeats the same promise to whoever reads it next",
   /A suggestion only: the desktop app follows it solely/.test(SQL));
ok("no pricing, checkout or dial route calls the new mapping",
   !/sl_lang_for_country/.test(read("supabase/functions/paystack-checkout/index.ts"))
   && !/sl_lang_for_country/.test(read("supabase/functions/start-session/index.ts")));
ok("the till's own checkout route was not rewired to share this file",
   !/_shared\/geo/.test(read("supabase/functions/paystack-checkout/index.ts")));
ok("the dial route still carries its own reading, untouched by this change",
   !/_shared\/geo/.test(read("supabase/functions/start-session/index.ts")));
const importers = readdirSync("supabase/functions").filter(d => {
  try { return readdirSync("supabase/functions/" + d).includes("index.ts"); } catch { return false; }
}).filter(d => read("supabase/functions/" + d + "/index.ts").includes("_shared/geo.ts"));
ok("exactly one route imports the shared address reader: the language route",
   importers.length === 1 && importers[0] === "account-language", importers.join(","));
const callers = readdirSync("supabase/functions").filter(d => {
  try { return readdirSync("supabase/functions/" + d).includes("index.ts"); } catch { return false; }
}).filter(d => read("supabase/functions/" + d + "/index.ts").includes("account-language"));
ok("no function calls itself; the only name for the route is its own folder",
   callers.length === 1 && callers[0] === "account-language", callers.join(","));
// Every route on this project validates the caller's own token and answers in its own words, so the
// platform must not be configured to refuse first: a route the platform blocks looks to the app like
// a transport failure, and the app cannot tell "no suggestion" from "the gateway is down".
const CONFIG = read("supabase/config.toml");
ok("the gateway config names this route and leaves the checking to it",
   /\[functions\.account-language\]\s*\nverify_jwt = false/.test(CONFIG));
ok("and no price, shelf or engine file was pulled into this change",
   !/sl_lang_for_country|account-language/.test(read("supabase/functions/paystack-checkout/index.ts") + read("supabase/functions/start-session/index.ts")));

// ── the built page, once a build has run ─────────────────────────────────────
const bundleSkip = process.env.AUTO_SKIP_BUILT === "1" || !existsSync("desktop/dist/index.html");
if (bundleSkip) {
  console.log("SKIP  the built-page checks (they run again after the vite build)");
} else {
  const html = read("desktop/dist/index.html");
  const js = (html.match(/src="\.?\/assets\/[^"]+\.js"/g) || [])
    .map(m => m.slice(6, -1).replace(/^\.?\//, ""))
    .map(p => read("desktop/dist/" + p)).join("\n");
  ok("the built page names the script it loads", js.length > 100000, js.length + " chars read");
  ok("the shipped bundle carries the record of his own choice", js.includes("streamlive.lang_chosen"));
  ok("and the address of the route that answers with a language", js.includes("account-language"));
  ok("the button's language names are still in the shipped page",
     js.includes("Español") && js.includes("Français") && js.includes("Português") && js.includes("العربية"));
  ok("nothing about a price moved into the language code",
     !/sl_lang_for_country/.test(js));
}

console.log(fails ? "\n" + fails + " FAILURE(S)" : "\nall country-language rules pass");
process.exit(fails ? 1 : 0);
