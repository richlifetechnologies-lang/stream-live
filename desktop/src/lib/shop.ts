// The till, and how the app reaches it.
//
// Inside the installed app a purchase opens a window of the app's own: no address bar, no
// browser history, nothing handed to the customer's browser. Anywhere else there is no app
// window to open, so the page simply comes up in a tab as it always did.

import { getLang } from "./i18n";

type ShopApi = { openCheckout?: (page: string) => void };

const api = (): ShopApi | undefined =>
  (window as unknown as { electronAPI?: ShopApi }).electronAPI;

/** True when a purchase can stay inside the app. */
export function tillOpensInApp(): boolean {
  return typeof api()?.openCheckout === "function";
}

/**
 * The till is a page of its own, on a session of its own, so it cannot read the app's
 * language — the word has to travel in the address. English is left out, because a bare
 * till URL is what the page already serves and an empty `?lang` is one more way to be
 * wrong. Anything the server already put in the address is kept.
 */
function withLang(page: string): string {
  const lang = getLang();
  if (lang === "en") return page;
  try {
    const url = new URL(page);
    if (url.searchParams.has("lang")) return page;
    url.searchParams.set("lang", lang);
    return url.toString();
  } catch {
    return page;
  }
}

/**
 * Which shelf the customer tapped travels to the till as `?market=`, and the method that
 * shelf pays with travels as `?way=`: the Ghana shelf sends `mobile_money`, the shelf for
 * users outside Ghana sends `card`. A till opened without either behaves exactly as it
 * always did and offers whatever the seller has switched on, so nothing here can strand a
 * buyer — the address is a request, not a demand.
 */
export type TillWay = "card" | "mobile_money";
export type TillMarket = "gh" | "intl";

function withParam(page: string, key: string, value?: string): string {
  if (!value) return page;
  try {
    const url = new URL(page);
    if (url.searchParams.has(key)) return page;
    url.searchParams.set(key, value);
    return url.toString();
  } catch {
    return page;
  }
}

function withWay(page: string, way?: TillWay): string {
  return withParam(page, "way", way);
}

export function openTill(page: string, way?: TillWay, market?: TillMarket): void {
  const shop = api();
  const withWord = withLang(withParam(withWay(page, way), "market", market));
  if (shop?.openCheckout) {
    shop.openCheckout(withWord);
    return;
  }
  window.open(withWord, "_blank", "noopener,noreferrer");
}

/** The way out when a network refuses the app's own window: the customer's browser. */
export function openTillInBrowser(page: string, way?: TillWay, market?: TillMarket): void {
  window.open(withLang(withParam(withWay(page, way), "market", market)), "_blank", "noopener,noreferrer");
}
