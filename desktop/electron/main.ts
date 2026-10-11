import { app, BrowserWindow, shell, session, ipcMain, dialog } from "electron";
import https from "https";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { initVirtualCameraIpc, shutdownVirtualCamera } from "./virtual-camera";

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

const GITHUB_OWNER = "richlifetechnologies-lang";
const GITHUB_REPO  = "stream-studio";

// ─── Asset pattern for the current platform + architecture ─────────────────
function getAssetPattern(): RegExp {
  if (process.platform === "win32") return /StreamStudio-Setup-.*\.exe$/i;
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return new RegExp(`StreamStudio-.*-${arch}\\.dmg`, "i");
  }
  return /StreamStudio-.*\.AppImage$/i;
}

// ─── Generic HTTPS GET with redirect following ────────────────────────────────
function httpsGet(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = (lib as typeof https).get(
      url,
      { headers: { "User-Agent": `stream-studio/${app.getVersion()}`, ...headers } },
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
      const headers: Record<string, string> = { "User-Agent": `stream-studio/${app.getVersion()}` };
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

// ─── IPC: fal.ai token mint (keeps API key in Main Process) ──────────────────
// The renderer asks for a short-lived JWT; we call fal's token endpoint here
// where the API key never touches the renderer bundle.
ipcMain.handle("get-fal-token", async (_event, apiKey: string, appId: string) => {
  // Strip "Key " prefix if user accidentally stored it that way, then re-add it cleanly
  const rawKey = apiKey.startsWith("Key ") ? apiKey.slice(4).trim() : apiKey.trim();
  if (!rawKey) throw new Error("FAL_KEY is missing or empty");

  // The token server validates scope against the alias only (e.g. "lucy-2-5" not "decart/lucy-2-5/realtime")
  // appId is already the alias when called from our tokenProvider
  const res = await fetch("https://rest.fal.ai/tokens/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Key ${rawKey}`,
    },
    body: JSON.stringify({
      allowed_apps: [appId],
      token_expiration: 120,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`fal.ai token error (${res.status}): ${txt}`);
  }
  // The tokens endpoint returns either a plain string token or a JSON object
  const raw = await res.text();
  try {
    const parsed = JSON.parse(raw);
    // Could be { detail: "token..." } or just the token string wrapped in JSON
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed.detail === "string") return parsed.detail;
    if (parsed && typeof parsed.token === "string") return parsed.token;
    // If it's some other object, stringify is wrong — return raw text
    return raw.replace(/^"|"$/g, ""); // strip quotes if it was a quoted string
  } catch {
    // Response was plain text token
    return raw.trim();
  }
});

// ─── IPC: trigger update download ────────────────────────────────────────────
ipcMain.on("download-update", () => {
  if (mainWindow) startInAppDownload(mainWindow);
});

// ─── IPC: quit and run the downloaded installer ───────────────────────────────
ipcMain.on("quit-and-install", () => {
  if (!pendingInstallerPath) return;
  shell.openPath(pendingInstallerPath).then(() => {
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
    title: "Stream Studio",
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
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://*.fal.ai wss://*.fal.ai https://wma.fal.run https://fal.run wss://fal.run https://*.fal.run wss://*.fal.run https://fonts.googleapis.com https://fonts.gstatic.com; media-src *; connect-src *;",
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
      title: "Welcome to Stream Studio",
      message: "One-time Mac setup complete",
      detail:
        "If macOS blocked this app when you first opened it, here's how to fix it:\n\n" +
        "1. Close Stream Studio\n" +
        "2. Right-click the app icon (or DMG) → Open\n" +
        "3. Click Open in the security dialog\n\n" +
        "You only need to do this once. After that it launches normally.\n\n" +
        "This happens because Stream Studio isn't signed with a paid Apple Developer certificate.",
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
