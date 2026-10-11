import { app, BrowserWindow, shell, session, ipcMain, dialog } from "electron";
import https from "https";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { initVirtualCameraIpc, shutdownVirtualCamera } from "./virtual-camera";

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

const GITHUB_OWNER = "richlifetechnologies-lang";
const GITHUB_REPO  = "stream-live";

// ─── Asset pattern for the current platform + architecture ─────────────────
function getAssetPattern(): RegExp {
  if (process.platform === "win32") return /StreamLive-Setup-.*\.exe$/i;
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return new RegExp(`StreamLive-.*-${arch}\\.dmg`, "i");
  }
  return /StreamLive-.*\.AppImage$/i;
}

// ─── Generic HTTPS GET with redirect following ────────────────────────────────
function httpsGet(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = (lib as typeof https).get(
      url,
      { headers: { "User-Agent": `stream-live/${app.getVersion()}`, ...headers } },
      (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          resolve(httpsGet(res.headers.location, headers));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
  });
}

// ─── Streaming download with progress, stall watchdog and resume ────────────
// A raw https.get with no timeout hangs forever if the CDN socket stalls mid
// transfer (progress freezes, promise never settles). So: kill the socket after
// IDLE_MS without bytes, retry with an HTTP Range resume of the partial file,
// and destroy redirect responses instead of leaking them.
function downloadFile(
  url: string,
  destPath: string,
  onProgress: (percent: number, transferred: number, total: number) => void
): Promise<void> {
  const IDLE_MS = 20_000;
  const MAX_ATTEMPTS = 4;
  return new Promise((resolve, reject) => {
    let attempt = 0;
    let settled = false;
    const done = (err?: Error) => { if (settled) return; settled = true; err ? reject(err) : resolve(); };

    const fetchOnce = (u: string, start: number): Promise<void> => new Promise((res, rej) => {
      const lib = u.startsWith("https") ? https : http;
      const headers: Record<string, string> = { "User-Agent": `stream-live/${app.getVersion()}` };
      if (start > 0) headers.Range = `bytes=${start}-`;
      const req = (lib as typeof https).get(u, { headers }, (resp) => {
        if ([301, 302, 307, 308].includes(resp.statusCode ?? 0) && resp.headers.location) {
          resp.destroy();
          fetchOnce(resp.headers.location, start).then(res, rej);
          return;
        }
        const partial = resp.statusCode === 206;
        if (resp.statusCode !== 200 && !partial) {
          resp.destroy(); rej(new Error(`Download failed with status ${resp.statusCode}`)); return;
        }
        let total = 0;
        if (partial) {
          const m = /\/(\d+)$/.exec(resp.headers["content-range"] ?? "");
          total = m ? parseInt(m[1], 10) : 0;
        } else {
          total = parseInt(resp.headers["content-length"] ?? "0", 10);
        }
        let transferred = partial ? start : 0;
        const dest = fs.createWriteStream(destPath, { flags: partial ? "a" : "w" });
        req.setTimeout(IDLE_MS, () => req.destroy(new Error("download stalled")));
        resp.on("data", (c: Buffer) => {
          transferred += c.length;
          if (total > 0) onProgress(Math.min(99, Math.round((transferred / total) * 100)), transferred, total);
        });
        resp.pipe(dest);
        dest.on("finish", () => dest.close(() => res()));
        dest.on("error", rej);
        resp.on("error", rej);
      });
      req.on("error", rej);
    });

    const tryAttempt = (): void => {
      attempt++;
      let start = 0;
      try { start = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0; } catch { start = 0; }
      fetchOnce(url, start)
        .then(() => done())
        .catch((err: Error) => {
          if (attempt >= MAX_ATTEMPTS) { done(err); return; }
          setTimeout(tryAttempt, 1500);
        });
    };
    tryAttempt();
  });
}

// ─── Version comparison (semver-lite: major.minor.patch) ─────────────────────
function isNewer(remote: string, local: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [rMaj, rMin, rPat] = parse(remote);
  const [lMaj, lMin, lPat] = parse(local);
  if (rMaj !== lMaj) return rMaj > lMaj;
  if (rMin !== lMin) return rMin > lMin;
  return rPat > lPat;
}

// ─── In-app updater state ─────────────────────────────────────────────────────
let pendingInstallerPath: string | null = null;
let latestDownloadUrl:    string | null = null;
let latestVersion:        string | null = null;

async function checkForUpdate(win: BrowserWindow) {
  try {
    const buf = await httpsGet(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      { Accept: "application/vnd.github+json" }
    );
    const release = JSON.parse(buf.toString("utf8")) as {
      tag_name: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    };

    const remoteVer = release.tag_name.replace(/^v/, "");
    const localVer  = app.getVersion();

    if (!isNewer(remoteVer, localVer)) return;

    const pattern = getAssetPattern();
    const asset   = release.assets.find((a) => pattern.test(a.name));
    if (!asset) return;

    latestVersion     = remoteVer;
    latestDownloadUrl = asset.browser_download_url;

    win.webContents.send("update-available", { version: remoteVer });
  } catch {
    // Best-effort — silently ignore
  }
}

async function startInAppDownload(win: BrowserWindow, overrideUrl?: string) {
  const downloadUrl = overrideUrl ?? latestDownloadUrl;
  if (!downloadUrl) return;

  try {
    // Infer a filename from the URL
    const filename    = decodeURIComponent(path.basename(new URL(downloadUrl).pathname));
    const destPath    = path.join(os.tmpdir(), filename);

    await downloadFile(
      downloadUrl,
      destPath,
      (percent, transferred, total) => {
        if (!win.isDestroyed()) {
          win.webContents.send("download-progress", { percent, transferred, total });
        }
      }
    );

    pendingInstallerPath = destPath;
    if (!win.isDestroyed()) win.webContents.send("update-downloaded");
  } catch {
    // Silently ignore download errors
  }
}

// ─── IPC: stable per-machine device id ───────────────────────────────────────
// The gateway binds metered leases to a device. Node exposes the OS machine id
// (Windows MachineGuid / macOS IOPlatformUUID), which survives app reinstall;
// fall back to a host fingerprint if the OS refuses.
ipcMain.handle("get-device-id", () => {
  try {
    return (os as typeof os & { machineIdSync(): string }).machineIdSync();
  } catch {
    return crypto
      .createHash("sha256")
      .update(`${os.hostname()}|${os.arch()}|${os.platform()}`)
      .digest("hex");
  }
});

// ─── IPC: trigger update download ────────────────────────────────────────────
ipcMain.on("download-update", () => {
  if (mainWindow) startInAppDownload(mainWindow);
});

// ─── IPC: quit and run the downloaded installer ───────────────────────────────
// Windows: launch the NSIS installer and let it replace the app.
// macOS: a DMG cannot overwrite a running app on its own, and an unsigned app
// has to be approved by the user anyway — so mount the DMG and show the drag
// steps instead of silently opening a Finder window.
ipcMain.on("quit-and-install", async () => {
  if (!pendingInstallerPath) return;
  const installer = pendingInstallerPath;

  if (process.platform === "darwin") {
    if (mainWindow && !mainWindow.isDestroyed()) {
      await dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Install the update",
        message: `Stream Live ${latestVersion ?? "new"} is downloaded`,
        detail:
          "A Finder window will open with the new version.\n\n" +
          "1. Drag “Stream Live” onto the Applications folder shortcut next to it.\n" +
          "2. Quit this window when it asks.\n" +
          "3. Open Stream Live from Applications. macOS will block it once — approve it in\n" +
          "   System Settings → Privacy & Security → “Open Anyway”.\n\n" +
          "Eject the disk image afterwards if you like.",
        buttons: ["Show me the DMG"],
        defaultId: 0,
      });
    }
    await shell.openPath(installer);
    app.quit();
    return;
  }

  shell.openPath(installer).then(() => {
    app.quit();
  }).catch(() => {
    app.quit();
  });
});

// ─── IPC: open-external — intercept old v1.4.0 update flow ───────────────────
// v1.4.0 compiled the following into its renderer: ipcRenderer.send("open-external", url)
// That old call is now caught here: if the URL looks like one of our installers, we
// download it in-app; otherwise we fall back to shell.openExternal as before.
ipcMain.on("open-external", (_event, url: string) => {
  if (typeof url !== "string") return;

  const isOurInstaller =
    url.includes(`github.com/${GITHUB_OWNER}/${GITHUB_REPO}`) &&
    getAssetPattern().test(decodeURIComponent(url));

  if (isOurInstaller && mainWindow) {
    // Inform the renderer that an in-app update is starting
    latestDownloadUrl = url;
    mainWindow.webContents.send("update-available", { version: latestVersion ?? "latest" });
    startInAppDownload(mainWindow, url);
  } else {
    shell.openExternal(url).catch(() => {});
  }
});

// ─── Virtual camera frame feeder (UnityCapture shared-memory protocol) ────────
// Registers vcam-start / vcam-stop / vcam-status / vcam-frame IPC. Fully guarded:
// if the native layer is unavailable the handlers report unsupported and the app
// keeps working exactly as before.
initVirtualCameraIpc(ipcMain);

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "Stream Live",
    backgroundColor: "#070d1a",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Grant media/camera/mic permissions — required for WebRTC in Electron.
  // "speaker-selection" is required for selectAudioOutput(), the fallback the
  // renderer uses to route AI audio into the VB-Cable sink.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ["media", "audioCapture", "videoCapture", "displayCapture", "speaker-selection"];
    callback(allowed.includes(permission));
  });

  // Required in Electron 20+ — without this the permission check fails silently
  // even after the request handler grants it, causing the camera to go black
  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    const allowed = ["media", "audioCapture", "videoCapture", "displayCapture", "speaker-selection"];
    return (allowed as string[]).includes(permission);
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          // connect-src is an explicit allow-list: the Supabase gateway (https + wss),
          // the fal relay hosts, the GitHub updater, and blob/data. rest.fal.ai is gone
          // — the gateway mints the JWT now, so the renderer must never reach a key endpoint.
          // localhost stays for the dev server and the app's own local API server.
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://*.fal.ai wss://*.fal.ai https://wma.fal.run https://fal.run wss://fal.run https://*.fal.run wss://*.fal.run https://fonts.googleapis.com https://fonts.gstatic.com; media-src *; connect-src 'self' http://localhost:* ws://localhost:* https://onhanfathvfkkliayvrn.supabase.co wss://onhanfathvfkkliayvrn.supabase.co https://*.fal.run wss://*.fal.run https://fal.run wss://fal.run https://api.github.com https://objects.githubusercontent.com data: blob:;",
        ],
      },
    });
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.webContents.on("did-fail-load", () => {
    if (!isDev && mainWindow) {
      mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
    }
  });

  // Kick off update check 5 s after the window is ready
  mainWindow.webContents.once("did-finish-load", () => {
    if (!isDev && mainWindow) {
      setTimeout(() => checkForUpdate(mainWindow!), 5000);
    }
  });
}

// ─── macOS first-launch Gatekeeper notice ────────────────────────────────────
function showMacFirstLaunchNotice() {
  if (process.platform !== "darwin" || isDev) return;
  const flagPath = path.join(app.getPath("userData"), ".mac-first-launch-shown");
  if (fs.existsSync(flagPath)) return;
  try { fs.writeFileSync(flagPath, "1"); } catch { /* ignore */ }

  // Show after a short delay so the window is fully painted
  setTimeout(() => {
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Welcome to Stream Live",
      message: "Approve Stream Live in System Settings",
      detail:
        "macOS blocks apps that aren't signed with a paid Apple Developer certificate, " +
        "so the very first launch is refused. That is expected — it only needs approving once.\n\n" +
        "1. Double-click Stream Live so macOS records the attempt.\n" +
        "2. Open System Settings → Privacy & Security.\n" +
        "3. Scroll to the Security section and click “Open Anyway” beside " +
        "“Stream Live was blocked”.\n" +
        "4. Enter your Mac password, then open Stream Live again.\n\n" +
        "If “Open Anyway” never appears, quit this app and run:\n" +
        "    xattr -dr com.apple.quarantine \"/Applications/Stream Live.app\"\n" +
        "in Terminal, then launch it again.\n\n" +
        "Still on this screen? Stream Settings → Mac Setup lists the same steps.",
      buttons: ["Got it"],
      defaultId: 0,
    });
  }, 2000);
}

app.whenReady().then(() => {
  createWindow();
  showMacFirstLaunchNotice();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  shutdownVirtualCamera();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  shutdownVirtualCamera();
});
