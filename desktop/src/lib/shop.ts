// The till, and how the app reaches it.
//
// Inside the installed app a purchase opens a window of the app's own: no address bar, no
// browser history, nothing handed to the customer's browser. Anywhere else there is no app
// window to open, so the page simply comes up in a tab as it always did.

type ShopApi = { openCheckout?: (page: string) => void };

const api = (): ShopApi | undefined =>
  (window as unknown as { electronAPI?: ShopApi }).electronAPI;

/** True when a purchase can stay inside the app. */
export function tillOpensInApp(): boolean {
  return typeof api()?.openCheckout === "function";
}

export function openTill(page: string): void {
  const shop = api();
  if (shop?.openCheckout) {
    shop.openCheckout(page);
    return;
  }
  window.open(page, "_blank", "noopener,noreferrer");
}

/** The way out when a network refuses the app's own window: the customer's browser. */
export function openTillInBrowser(page: string): void {
  window.open(page, "_blank", "noopener,noreferrer");
}
