// The payment window itself: an app-owned window with no address bar, running on a
// session of its own, holding to the rules in checkout-guard.
//
// It is deliberately not the app's session. On its own session the window inherits
// none of the app's permissions (no camera, no microphone, no notifications), none of
// the app's content policy, and nothing that could read a signed-in account. Nothing is
// persisted: when the window closes, its cookies and its history go with it, so the
// till leaves no trace on the customer's machine and no trace of itself either.

import { app, BrowserWindow, session, shell } from "electron";
import {
  CHECKOUT_PARTITION,
  checkoutPageHost,
  checkoutWindowTitle,
  departsTillForProvider,
  isReceiptUrl,
  navigationAction,
  paymentUserAgent,
  popupAction,
  refererAction,
  verificationNavigation,
} from "./checkout-guard";

let checkoutWindow: BrowserWindow | null = null;
let tillHost = "";
let wired = false;
let note: (line: string) => void = () => {};
let onReceipt: () => void = () => {};

export function initCheckoutWindow(logNote: (line: string) => void, receiptSeen: () => void): void {
  note = logNote;
  onReceipt = receiptSeen;
}

/**
 * The session the till runs on, wired once. Every part of this is a refusal: the page
 * that takes a card number has no business asking for a camera, keeping a download, or
 * seeing the seller's till address in its referrer.
 */
function checkoutSession(): Electron.Session {
  const ses = session.fromPartition(CHECKOUT_PARTITION);
  if (wired) return ses;
  wired = true;

  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => {
    event.preventDefault();
    note("a payment window tried to hand down a file; refused");
  });

  // A payment provider's risk checks read the browser's description of itself, so the
  // window travels as a plain browser rather than as this app.
  const fallback = app.userAgentFallback || session.defaultSession.getUserAgent();
  ses.setUserAgent(paymentUserAgent(fallback));

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    if (refererAction(tillHost, details.referrer ?? headers.Referer ?? headers.referer, details.url) === "strip") {
      delete headers.Referer;
      delete headers.referer;
    }
    callback({ requestHeaders: headers });
  });

  return ses;
}

/** The rules for the till window itself: the seller's page, then the provider's. */
function guardTill(win: BrowserWindow, wc: Electron.WebContents): void {
  wc.on("will-navigate", (event, target) => {
    const action = navigationAction(tillHost, wc.getURL(), target);
    if (action === "allow") {
      // The step off the seller's page onto the provider's is the one hop that would carry
      // the till's address along as its referrer, and the provider's own script could then
      // read it back. Taking the address out of the header is not enough for that, so the
      // window asks for the provider's page again itself and says where it came from:
      // nowhere. Every other navigation is left exactly as the page started it.
      if (!departsTillForProvider(tillHost, wc.getURL(), target)) return;
      event.preventDefault();
      void wc
        .loadURL(target, { httpReferrer: { url: "", policy: "no-referrer" } })
        .catch(() => note("the payment page at the provider could not be opened"));
      return;
    }
    event.preventDefault();
    if (action === "external") {
      void shell.openExternal(target).catch(() => {});
      return;
    }
    note("a payment window was offered an address outside the till and the provider; refused");
  });

  // Only the provider's page may open a window, and only for the bank's own
  // verification step. Anything else - including a link the till page never intended to
  // open - comes back as a refusal rather than as a second browser on screen.
  wc.setWindowOpenHandler(({ url }) => {
    if (popupAction(wc.getURL(), url) === "refuse") {
      note("a payment window tried to open another window; refused");
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        parent: win,
        width: 620,
        height: 760,
        title: "Bank verification",
        autoHideMenuBar: true,
        backgroundColor: "#070d1a",
        webPreferences: {
          partition: CHECKOUT_PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          devTools: false,
        },
      },
    };
  });

  // The bar follows the customer: their own till, then the provider's page, and the app
  // says so in those words. Coming back to the till with an order reference in the address
  // is the receipt, and the only thing taken from it is a prompt to read the account again
  // - the app does not conclude from a page that money moved.
  const onUrl = (url: string) => {
    win.setTitle(checkoutWindowTitle(tillHost, url));
    if (isReceiptUrl(tillHost, url)) onReceipt();
  };
  wc.on("did-navigate", (_e, url) => onUrl(url));
  wc.on("did-navigate-in-page", (_e, url) => onUrl(url));
  // The bar is what tells the customer whose hands the card is in, so it is the app's
  // word on the matter rather than whatever the page would like it to say.
  win.on("page-title-updated", (event) => {
    event.preventDefault();
    win.setTitle(checkoutWindowTitle(tillHost, wc.getURL()));
  });
}

/** The rules for a verification window: plain https, and no further windows of its own. */
function guardVerification(wc: Electron.WebContents): void {
  wc.on("will-navigate", (event, target) => {
    if (verificationNavigation(target)) return;
    event.preventDefault();
    note("a verification window was offered a non-https address; refused");
  });
  wc.setWindowOpenHandler(({ url }) =>
    verificationNavigation(url) ? { action: "allow" } : { action: "deny" }
  );
}

export function openCheckoutWindow(page: string, parent: BrowserWindow | null): { ok: boolean; reason: string } {
  const host = checkoutPageHost(page);
  if (!host) return { ok: false, reason: "the payment address the server publishes is not usable" };

  // One till at a time. If it is already open it is part-way through somebody's payment,
  // so it is shown rather than reloaded.
  if (checkoutWindow && !checkoutWindow.isDestroyed()) {
    checkoutWindow.show();
    checkoutWindow.focus();
    return { ok: true, reason: "already open" };
  }

  tillHost = host;
  // Wiring the session has to happen before the first request leaves the window.
  checkoutSession();

  const win = new BrowserWindow({
    width: 880,
    height: 840,
    minWidth: 380,
    minHeight: 520,
    title: checkoutWindowTitle(tillHost, page),
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#070d1a",
    webPreferences: {
      partition: CHECKOUT_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  win.setMenu(null);
  win.setMenuBarVisibility(false);
  checkoutWindow = win;
  guardTill(win, win.webContents);

  win.webContents.on("did-create-window", (child) => {
    child.setMenu(null);
    child.setMenuBarVisibility(false);
    guardVerification(child.webContents);
  });

  win.on("closed", () => {
    if (checkoutWindow === win) checkoutWindow = null;
  });

  win.webContents.on("did-fail-load", (_e, code, _reason, _url, mainFrame) => {
    if (mainFrame) note(`the payment window could not be loaded (code ${code})`);
  });

  win.once("ready-to-show", () => win.show());
  void win.loadURL(page).catch(() => note("the payment window could not start"));

  return { ok: true, reason: "opened" };
}
