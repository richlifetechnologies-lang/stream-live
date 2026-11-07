// The floating line that shows what the caller said, over whatever app the call is really
// happening in.
//
// It is a window of the app's own rather than a strip inside the app's page, because a man on a
// video call never looks at this window: he looks at the calling app. A bar he has to tab back to
// is a bar he does not read. So it holds nothing but one line of text, it stays above everything
// else on the screen, and it refuses the mouse - a click on it goes through to whatever is behind
// it, because a subtitle that can be clicked is a subtitle that can steal his call.
//
// It is deliberately frameless, transparent, unlisted in the taskbar and unfocusable: it must not
// appear in Alt+Tab, must not take focus from the call, and must not look like a program the
// customer has to manage.

import { app, BrowserWindow, screen } from "electron";
import path from "path";
import { pathToFileURL } from "url";

const BAR_W = 820;
const BAR_H = 96;

let bar: BrowserWindow | null = null;
let note: (line: string) => void = () => {};

export function initSubtitleBar(logNote: (line: string) => void): void {
  note = logNote;
}

/** The bar's page: shipped in `dist/` beside the app's own, served by the dev server in dev. */
function barPage(): string {
  const dev = process.env.NODE_ENV === "development" || !app.isPackaged;
  if (dev) return "http://localhost:5173/subtitle-bar.html";
  return pathToFileURL(path.join(__dirname, "../dist/subtitle-bar.html")).toString();
}

/** Bottom-centre of the screen the call is on, high enough to clear a calling app's own controls. */
function placeBar(win: BrowserWindow): void {
  const area = screen.getPrimaryDisplay().workArea;
  win.setBounds({
    x: Math.round(area.x + (area.width - BAR_W) / 2),
    y: Math.round(area.y + area.height - BAR_H - 88),
    width: BAR_W,
    height: BAR_H,
  });
}

export function openSubtitleBar(): { ok: boolean; reason: string } {
  if (bar && !bar.isDestroyed()) {
    placeBar(bar);
    bar.show();
    return { ok: true, reason: "already open" };
  }
  const win = new BrowserWindow({
    width: BAR_W,
    height: BAR_H,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    title: "Subtitles",
    webPreferences: {
      preload: path.join(__dirname, "preload-bar.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      webSecurity: true,
    },
  });
  bar = win;

  // "screen-saver" is the level above a full-screen calling app, which is exactly where the
  // customer's call lives; the ordinary level loses to it and the line disappears mid-call.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  placeBar(win);
  // Nothing in this window is for clicking, so nothing in it may take a click.
  win.setIgnoreMouseEvents(true);
  win.on("closed", () => { if (bar === win) bar = null; });
  win.webContents.on("did-fail-load", (_e, code) => {
    if (code !== -3) note(`the subtitle line could not be loaded (code ${code})`);
  });

  win.once("ready-to-show", () => win.show());
  void win.loadURL(barPage()).catch(() => note("the subtitle line could not start"));
  return { ok: true, reason: "opened" };
}

export function closeSubtitleBar(): void {
  if (!bar || bar.isDestroyed()) return;
  bar.destroy();
  bar = null;
}

/** The current line, or nothing at all when the call has not said anything yet. */
export function sendSubtitleLine(line: { chip: string; text: string; asSaid: string }): void {
  if (!bar || bar.isDestroyed()) return;
  bar.webContents.send("bar-line", line);
}
