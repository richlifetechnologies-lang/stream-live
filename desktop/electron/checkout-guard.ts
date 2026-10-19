// The rules the payment window runs on, kept apart from Electron so they can be tested
// by asking them directly instead of by paying for a real order.
//
// The window exists because the Buy button used to hand the customer's browser the
// seller's payment address. These rules are what makes it safe to keep that inside the
// app instead: the window only ever goes to the till page or to the payment provider,
// it is never the app's own session, and nothing that page asks for is granted.

/** The payment window's own session, with no `persist:` prefix so nothing outlives it. */
export const CHECKOUT_PARTITION = "sl-checkout";

/**
 * The provider's own hosts. A hosted payment page is where the card details go, so the
 * window has to follow it there; nothing else on this list, and a suffix test rather
 * than a substring so `paystack.com.phishing.example` is not payment provider.
 */
const PROVIDER_HOSTS = ["paystack.com", "paystack.co"];

export function isProviderHost(host: string): boolean {
  const h = host.toLowerCase();
  return PROVIDER_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Dressed up as the payment provider without being it. Worth naming on its own: a page
 * that only looks like the till's provider must never be reached from inside the app, not
 * even by handing it to the browser, where it would look convincing enough to type into.
 */
function impersonatesProvider(host: string): boolean {
  return /paystack/i.test(host) && !isProviderHost(host);
}

/**
 * An https host with no credentials and no odd port, or null. Everything else the window
 * is offered goes through this, so `javascript:`, `http:`, `data:` and a URL with a
 * password typed into it are refused before they can be compared with anything.
 */
export function safeHttpsHost(href: string): string | null {
  let u: URL;
  try {
    u = new URL(String(href ?? ""));
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "443") return null;
  const h = u.hostname.toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(h) || !h.includes(".")) return null;
  return h;
}

/**
 * The address the gateway publishes as its till. It comes from the seller's own server
 * rather than from the app, so a page that moves is followed without a new build — which
 * is also how it will pick up a branded domain later. A provider address is refused here:
 * the till is ours, and opening Paystack as if it were the till would put the window in
 * the wrong place with nothing to choose from.
 */
export function checkoutPageHost(page: string): string | null {
  const host = safeHttpsHost(page);
  if (!host) return null;
  if (isProviderHost(host) || impersonatesProvider(host)) return null;
  return host;
}

/** This app's own document: the packed files, or the dev server while developing. */
export function isAppDocumentUrl(href: string): boolean {
  let u: URL;
  try {
    u = new URL(String(href ?? ""));
  } catch {
    return false;
  }
  if (u.protocol === "file:") return true;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

/**
 * Where the window is allowed to go. Staying on the till or moving to the provider is
 * allowed; leaving the provider back to the till (the receipt) is allowed by the same
 * rule; anything else is refused.
 *
 * A foreign link on the seller's own page — the help address, the terms — is handed to
 * the browser instead of refused: the customer is not left clicking a dead link, and the
 * app is not the one showing a page it cannot vouch for. From the provider's page there
 * is no such escape, because that is the moment somebody could be lured off the till.
 */
export function navigationAction(
  tillHost: string,
  fromUrl: string,
  targetUrl: string,
): "allow" | "external" | "refuse" {
  const to = safeHttpsHost(targetUrl);
  if (!to) return "refuse";
  // Where the window is standing decides whether it may move at all. The till and the
  // provider are the only two places it can legitimately be, so a window that somehow
  // reached anywhere else is not allowed to wander on from there.
  const from = safeHttpsHost(fromUrl);
  if (from !== tillHost && !(from && isProviderHost(from))) return "refuse";
  if (impersonatesProvider(to)) return "refuse";
  if (to === tillHost || isProviderHost(to)) return "allow";
  return from === tillHost ? "external" : "refuse";
}

/**
 * A bank's own verification step is opened by the provider's page, on the bank's address,
 * and there is no list of those addresses to keep. So a window opened from the provider's
 * page is allowed, https only, and the window it opens is then held to plain https.
 * Without this a card payment stops dead at the one step that decides it.
 */
export function popupAction(fromUrl: string, targetUrl: string): "allow" | "refuse" {
  const from = safeHttpsHost(fromUrl);
  if (!from || !isProviderHost(from)) return "refuse";
  if (targetUrl === "about:blank" || targetUrl === "") return "allow";
  const to = safeHttpsHost(targetUrl);
  if (!to || impersonatesProvider(to)) return "refuse";
  return "allow";
}

/** Inside a window that was legitimately opened for verification: https, nothing less. */
export function verificationNavigation(targetUrl: string): boolean {
  const to = safeHttpsHost(targetUrl);
  return to !== null && !impersonatesProvider(to);
}

/**
 * The till page's address is the thing the seller would rather not have printed on
 * somebody else's screen, so it is only ever sent back to the till itself. Requests
 * inside the provider's own site keep their referrer - it names the provider, not the
 * seller - and removing it there is how payment pages break.
 */
export function refererAction(
  tillHost: string,
  refererUrl: string | undefined,
  targetUrl: string,
): "strip" | "keep" {
  if (!refererUrl) return "keep";
  const from = safeHttpsHost(refererUrl);
  const to = safeHttpsHost(targetUrl);
  if (!from || !to) return "keep";
  return from === tillHost && to !== tillHost ? "strip" : "keep";
}

/**
 * The step off the seller's page and onto the provider's - the one hop where the till's own
 * address would otherwise travel with the customer.
 *
 * Stripping the request header is only half of it: the browser keeps the address for the
 * page it is opening, so the provider's own script could still read it back off
 * `document.referrer`. So the window asks for that one page a second time itself, with the
 * referrer deliberately empty, and nothing on the other side ever learns where the customer
 * came from. Only this hop is re-asked; inside the provider's own site the referrer stays,
 * because removing it there is how payment pages break.
 */
export function departsTillForProvider(tillHost: string, fromUrl: string, targetUrl: string): boolean {
  const from = safeHttpsHost(fromUrl);
  const to = safeHttpsHost(targetUrl);
  if (!from || !to || from !== tillHost) return false;
  return isProviderHost(to) && !impersonatesProvider(to);
}

/**
 * The till showing a receipt. It comes back to the seller's own page with the order's
 * reference in the address, and that moment is worth noticing: it means the customer has
 * paid and is looking at the answer. Nothing is concluded from it here — the app simply
 * goes and reads the account again instead of waiting for the next scheduled look.
 */
export function isReceiptUrl(tillHost: string, url: string): boolean {
  const host = safeHttpsHost(url);
  if (!host || host !== tillHost) return false;
  try {
    const p = new URL(url).searchParams;
    return Boolean(p.get("check") || p.get("reference") || p.get("trxref"));
  } catch {
    return false;
  }
}

/**
 * What the bar reads. The window has no address bar, so the title is the only thing the
 * customer has to say whose hands the card details are in — naming the provider there is
 * what keeps a hidden address from reading like a spoof.
 */
export function checkoutWindowTitle(tillHost: string, url: string): string {
  const host = safeHttpsHost(url);
  if (host && host === tillHost) return "Stream Live — checkout";
  if (host && isProviderHost(host)) return "Paystack — secure payment";
  if (host) return "Bank verification";
  return "Stream Live — checkout";
}

/**
 * Risk checks on a payment page read the browser's own description of itself. An
 * Electron-flavoured one can be treated as a bot, so the window travels as a plain
 * browser: the app's name and the framework's name come off, the engine versions stay.
 */
export function paymentUserAgent(current: string): string {
  return String(current ?? "")
    // Whatever this build calls itself, it calls itself in the slot just before Chrome's
    // own token - that is where an Electron app puts its name, and the name changes between
    // a development run ("stream-live/1.8.11") and the packaged one ("StreamLive/1.8.11").
    .replace(/\s\S*\/[^\s]+(?=\sChrome\/)/, "")
    .replace(/\s?Electron\/[0-9][0-9a-zA-Z.+-]*/gi, "")
    .replace(/\s?stream[-_ ]?live\/[0-9][0-9a-zA-Z.+-]*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
