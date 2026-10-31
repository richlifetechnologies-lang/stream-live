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
