import { useSyncExternalStore } from "react";
import { es } from "./i18n-es";
import { pt } from "./i18n-pt";
import { fr } from "./i18n-fr";
import { ar } from "./i18n-ar";

/**
 * The customer's language, chosen from the corner of the window and kept on his machine.
 *
 * The English sentence is the key, and a key that no language file answers comes back
 * as itself. So an untranslated line is an English line, never a blank one - which is the
 * only reason this can be shipped a page at a time without a half-finished language
 * emptying a screen on somebody mid-call.
 */
export type LangCode = "en" | "es" | "pt" | "fr" | "ar";

/** Each language is written in its own script first: a user who cannot read English
 *  still recognises "Español", and would not recognise the word "Spanish". */
export const LANGS: { code: LangCode; native: string; english: string }[] = [
  { code: "en", native: "English", english: "English" },
  { code: "es", native: "Español", english: "Spanish" },
  { code: "pt", native: "Português", english: "Portuguese" },
  { code: "fr", native: "Français", english: "French" },
  { code: "ar", native: "العربية", english: "Arabic" },
];

const DICTS: Record<LangCode, Record<string, string>> = { en: {}, es, pt, fr, ar };
const STORE_KEY = "streamlive.lang";
/**
 * The record that says a person chose for himself, and the only reason the automatic pick can be
 * told apart from his.
 *
 * It is written by the language button and by nothing else. Without it there is one number on this
 * machine and no way to know who set it, so a customer who deliberately reads his app in Spanish
 * would lose that the next time he signs in from a country the server reads differently. With it,
 * the automatic suggestion is obeyed once, on a machine he has never made a choice on, and never
 * again.
 */
const CHOSEN_KEY = "streamlive.lang_chosen";

function detect(): LangCode {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved && LANGS.some(l => l.code === saved)) return saved as LangCode;
  } catch { /* a locked-down profile still gets a working app */ }
  // Windows' own locale decides the first run, so a Spanish user starts in Spanish
  // without having to read the app to find the setting that translates it.
  const iso = (typeof navigator !== "undefined" && navigator.language ? navigator.language : "en")
    .slice(0, 2).toLowerCase();
  return (LANGS.some(l => l.code === iso) ? iso : "en") as LangCode;
}

let current: LangCode = detect();
let dict = DICTS[current];
const subscribers = new Set<() => void>();

export function t(english: string, vars?: Record<string, string | number>): string {
  const s = dict[english] ?? english;
  // A sentence with a figure in it is one key with a hole, not three keys glued
  // together, so a language can put the number where its own grammar wants it.
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (hole, key: string) => (key in vars ? String(vars[key]) : hole));
}

export function getLang(): LangCode {
  return current;
}

export function setLang(next: LangCode) {
  // The flag is written even when the language is already the one on screen: pressing the button
  // on the language he is already reading is still him deciding, and a decision that quietly
  // failed to stick is worse than no decision at all.
  try { localStorage.setItem(CHOSEN_KEY, "1"); } catch { /* nothing to remember on; the auto pick may still apply */ }
  apply(next);
}

/**
 * The automatic route, and the only place the server's suggestion is allowed to land.
 *
 * It refuses itself once the customer has ever used the button, so the language he picked for
 * himself cannot be taken back by a reading he never agreed to — and it leaves no "he chose" mark,
 * so a wrong guess about a VPN is corrected by his own next click, permanently.
 */
export function setLangAuto(next: LangCode) {
  if (hasChosenLang()) return;
  apply(next);
}

/** Whether a person has chosen the language on this machine himself. */
export function hasChosenLang(): boolean {
  try { return localStorage.getItem(CHOSEN_KEY) === "1"; } catch { return false; }
}

function apply(next: LangCode) {
  if (next === current) return;
  current = next;
  dict = DICTS[next];
  try { localStorage.setItem(STORE_KEY, next); } catch { /* remembering is a convenience */ }
  subscribers.forEach(fn => fn());
}

/** Re-renders whatever calls it when the language changes. The tree is re-rendered,
 *  never remounted - an on-air call keeps its video, its audio and its meter. */
export function useLang(): LangCode {
  return useSyncExternalStore(
    cb => { subscribers.add(cb); return () => { subscribers.delete(cb); }; },
    getLang,
    getLang,
  );
}
