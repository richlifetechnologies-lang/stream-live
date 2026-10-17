import { app, BrowserWindow, shell, session, ipcMain, dialog } from "electron";
import https from "https";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { initVirtualCameraIpc, shutdownVirtualCamera } from "./virtual-camera";

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

// The app must be able to start producing sound on its own: a call is resumed after
// several awaits, so Chromium's default autoplay policy can leave the voice-cloning
// audio engine asleep and the cable silent while every meter on screen still moves.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let mainWindow: BrowserWindow | null = null;

const GITHUB_OWNER = "richlifetechnologies-lang";
// Installed apps read their updates from the downloads repo, which holds nothing but
// the installers. The source repo can then go private without blinding the updater.
const GITHUB_REPO  = "stream-live-releases";

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // scheduled re-check cadence
const FOCUS_CHECK_MIN_GAP_MS   = 15 * 60 * 1000;      // focus-triggered checks are throttled
const RATE_LIMIT_BACKOFF_MS    = 60 * 60 * 1000;      // ceiling for an unauthenticated GitHub backoff
const UPDATER_LOG_MAX_BYTES    = 256 * 1024;

// ─── Asset pattern for the current platform + architecture ─────────────────
function getAssetPattern(): RegExp {
  if (process.platform === "win32") return /StreamLive-Setup-.*\.exe$/i;
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return new RegExp(`StreamLive-.*-${arch}\\.dmg`, "i");
  }
  return /StreamLive-.*\.AppImage$/i;
}

function platformArtifactLabel(): string {
  if (process.platform === "win32") return "Windows";
  if (process.platform === "darwin") return `macOS (${process.arch})`;
  return "Linux";
}

// Append-only updater log. A silent failure is what made "I don't get the banner"
// unanswerable, so every early exit writes a line here. Values are reasons only —
// never a token or key.
function logUpdate(message: string): void {
  try {
    const file = path.join(app.getPath("userData"), "updater.log");
    try {
      if (fs.statSync(file).size > UPDATER_LOG_MAX_BYTES) {
        const lines = fs.readFileSync(file, "utf8").split("\n");
        fs.writeFileSync(file, lines.slice(Math.ceil(lines.length / 2)).join("\n"));
      }
    } catch { /* first write creates it */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch { /* logging must never break the updater */ }
}

type UpdateStatusKind = "check-failed" | "download-failed" | "ok";

function reportStatus(win: BrowserWindow | null, kind: UpdateStatusKind, message?: string): void {
  if (kind === "ok") logUpdate("check ok");
  else logUpdate(`${kind}: ${message ?? "unknown"}`);
  if (win && !win.isDestroyed()) win.webContents.send("update-status", { kind, message });
}

function reasonOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/https?:\/\/\S+/g, "endpoint").slice(0, 160);
}

// ─── Generic HTTPS GET with redirect following ────────────────────────────────
type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

function httpsGetFull(url: string, headers: Record<string, string> = {}, redirectsLeft = 5): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = (lib as typeof https).get(
      url,
      { headers: { "User-Agent": `stream-live/${app.getVersion()}`, ...headers } },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode ?? 0) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          resolve(httpsGetFull(new URL(res.headers.location, url).toString(), headers, redirectsLeft - 1));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
        res.on("error", reject);
      }
    );
    req.setTimeout(20_000, () => req.destroy(new Error("the request timed out")));
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
        if (resp.statusCode === 416 && start > 0) {
          // The leftover is already at or past the end of the asset, so the range
          // asking for "the rest" cannot be satisfied — and every retry asks the
          // same impossible one. Drop the leftover and download whole again.
          resp.destroy();
          try { fs.rmSync(destPath, { force: true }); } catch { /* ignore */ }
          logUpdate("server refused the resume range — restarting the download from zero");
          fetchOnce(u, 0).then(res, rej);
          return;
        }
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
// A tag like v1.5.0-rc1 must still compare as 1.5.0 — parsing it whole yields NaN,
// every comparison goes false and the banner silently never appears.
function isNewer(remote: string, local: string): boolean {
  const parse = (v: string) =>
    v.replace(/^v/, "").split(/[+\-]/)[0].split(".").map((n) => Number(n) || 0);
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
let notifiedVersion:      string | null = null;
let checkInFlight         = false;
let downloadInFlight      = false;
let lastCheckAt           = 0;
let rateLimitedUntil      = 0;
let updateCheckTimer: NodeJS.Timeout | null = null;

type Verification = {
  algo: "sha512" | "sha256";
  encoding: "base64" | "hex";
  expected: string;
  source: string;
  size?: number;
};
let pendingVerification: Verification | null = null;

function updaterYmlName(): string {
  if (process.platform === "win32") return "latest.yml";
  if (process.platform === "darwin") return "latest-mac.yml";
  return "latest-linux.yml";
}

// electron-builder's yml is a flat key/value document, so it is read line-wise
// instead of pulling in a YAML parser.
function parseUpdaterYml(text: string): { sha512?: string; path?: string; size?: number } {
  const field = (key: string): string | undefined => {
    const m = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m").exec(text);
    return m ? m[1].replace(/^["']|["']$/g, "") : undefined;
  };
  const size = field("size");
  return { sha512: field("sha512"), path: field("path"), size: size ? Number(size) : undefined };
}

function hashFile(file: string, algo: "sha512" | "sha256", encoding: "base64" | "hex"): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    stream.on("end", () => resolve(hash.digest(encoding)));
  });
}

// The sha512 in latest.yml is BASE64, not hex — hashing hex and comparing would
// never match, so the digest encoding is carried alongside the expected value.
async function resolveVerification(
  tag: string,
  asset: { name: string; digest?: string }
): Promise<Verification | null> {
  const yml = updaterYmlName();
  try {
    const res = await httpsGetFull(
      `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${tag}/${yml}`
    );
    if (res.status >= 200 && res.status <= 299) {
      const parsed = parseUpdaterYml(res.body.toString("utf8"));
      if (parsed.sha512) {
        if (parsed.path && parsed.path !== asset.name) {
          logUpdate(`${yml} lists ${parsed.path} but the release asset is ${asset.name} — not trusting that checksum`);
        } else {
          logUpdate(`checksum for ${asset.name} from ${yml} (sha512/base64)`);
          return { algo: "sha512", encoding: "base64", expected: parsed.sha512, source: yml, size: parsed.size };
        }
      } else {
        logUpdate(`${yml} has no sha512 field`);
      }
    } else {
      logUpdate(`${yml} fetch returned ${res.status}`);
    }
  } catch (err) {
    logUpdate(`${yml} unavailable: ${reasonOf(err)}`);
  }

  const digest = /^(sha256|sha512):([0-9a-f]+)$/i.exec((asset.digest ?? "").trim());
  if (digest) {
    const algo = digest[1].toLowerCase() as "sha256" | "sha512";
    logUpdate(`checksum for ${asset.name} from the GitHub asset digest (${algo})`);
    return { algo, encoding: "hex", expected: digest[2].toLowerCase(), source: "asset digest" };
  }
  logUpdate(`no checksum available for ${asset.name} — the artifact would be installed unverified`);
  return null;
}

async function checkForUpdate(win: BrowserWindow, opts: { force?: boolean } = {}) {
  if (isDev || win.isDestroyed()) return;
  if (checkInFlight) { logUpdate("check skipped — a check is already running"); return; }

  const now = Date.now();
  // Unauthenticated GitHub API is 60 req/hour/IP: while backed off every path
  // through here skips, so a scheduled check can't keep burning the window on 403s.
  if (now < rateLimitedUntil) { logUpdate("check skipped — backing off after a GitHub rate limit"); return; }
  if (!opts.force && now - lastCheckAt < FOCUS_CHECK_MIN_GAP_MS) return;

  checkInFlight = true;
  lastCheckAt = now;

  try {
    const res = await httpsGetFull(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      { Accept: "application/vnd.github+json" }
    );

    const remaining = res.headers["x-ratelimit-remaining"];
    const backoffMs = (headers: http.IncomingHttpHeaders): number => {
      const reset = Number(headers["x-ratelimit-reset"] ?? 0) * 1000;
      return Math.max(reset > now ? Math.min(reset - now, RATE_LIMIT_BACKOFF_MS) : RATE_LIMIT_BACKOFF_MS, 60_000);
    };

    if (res.status === 403 || res.status === 429 || (remaining === "0" && res.status >= 400)) {
      rateLimitedUntil = now + backoffMs(res.headers);
      reportStatus(win, "check-failed", "the update service is busy on this network — Stream Live will retry by itself");
      return;
    }
    // A healthy reply can still be the last of the hourly budget; honour it so the
    // next scheduled check waits instead of tripping the limit.
    if (remaining === "0") rateLimitedUntil = now + backoffMs(res.headers);

    if (res.status === 404) {
      reportStatus(win, "check-failed", "no version of Stream Live has been announced yet");
      return;
    }
    if (res.status < 200 || res.status > 299) {
      reportStatus(win, "check-failed", `the update service answered ${res.status}`);
      return;
    }

    let release: {
      tag_name: string;
      assets: Array<{ name: string; browser_download_url: string; digest?: string }>;
    };
    try {
      release = JSON.parse(res.body.toString("utf8"));
    } catch {
      reportStatus(win, "check-failed", "the update service sent a reply Stream Live couldn’t read");
      return;
    }

    const remoteVer = String(release.tag_name ?? "").replace(/^v/, "");
    const localVer  = app.getVersion();
    if (!remoteVer) {
      reportStatus(win, "check-failed", "the update service announced a version with no number");
      return;
    }

    logUpdate(`checked v${remoteVer} against installed v${localVer}`);
    if (!isNewer(remoteVer, localVer)) { reportStatus(win, "ok"); return; }

    const pattern = getAssetPattern();
    const asset   = release.assets.find((a) => pattern.test(a.name));
    if (!asset) {
      reportStatus(win, "check-failed", `v${remoteVer} has no ${platformArtifactLabel()} installer`);
      logUpdate(`assets on v${remoteVer}: ${release.assets.map((a) => a.name).join(", ") || "none"}`);
      return;
    }

    latestVersion     = remoteVer;
    latestDownloadUrl = asset.browser_download_url;

    // One offer per version: re-sending it on every later focus check would knock a
    // finished download back to "available" in the banner.
    if (notifiedVersion === remoteVer) return;
    pendingVerification = await resolveVerification(String(release.tag_name), asset);
    notifiedVersion = remoteVer;

    if (win.isDestroyed()) return;
    win.webContents.send("update-available", { version: remoteVer });
  } catch (err) {
    reportStatus(win, "check-failed", reasonOf(err));
  } finally {
    checkInFlight = false;
  }
}

async function startInAppDownload(win: BrowserWindow, overrideUrl?: string) {
  if (win.isDestroyed()) return;
  const downloadUrl = overrideUrl ?? latestDownloadUrl;
  if (!downloadUrl) {
    reportStatus(win, "download-failed", "no installer URL is known yet — try checking for updates again");
    return;
  }
  if (downloadInFlight) { logUpdate("download skipped — a download is already running"); return; }

  downloadInFlight = true;
  try {
    // Infer a filename from the URL
    const filename    = decodeURIComponent(path.basename(new URL(downloadUrl).pathname));
    const destPath    = path.join(os.tmpdir(), filename);

    // A leftover from an earlier attempt is only worth resuming if it is genuinely
    // shorter than the real installer. An abandoned-but-complete file would make the
    // first request an unsatisfiable range, which is the "416" dead end.
    const knownSize = pendingVerification?.size ?? 0;
    if (knownSize > 0 && fs.existsSync(destPath)) {
      const have = fs.statSync(destPath).size;
      if (have >= knownSize) {
        logUpdate(`discarding leftover ${filename} (${have} of ${knownSize} bytes) — downloading fresh`);
        fs.rmSync(destPath, { force: true });
      }
    }

    await downloadFile(
      downloadUrl,
      destPath,
      (percent, transferred, total) => {
        if (!win.isDestroyed()) {
          win.webContents.send("download-progress", { percent, transferred, total });
        }
      }
    );

    const v = pendingVerification;
    if (!v) {
      logUpdate(`installing ${filename} unverified — no checksum was published for it`);
    } else {
      const expectedSize = v.size ?? 0;
      if (expectedSize > 0 && fs.statSync(destPath).size !== expectedSize) {
        fs.rmSync(destPath, { force: true });
        pendingInstallerPath = null;
        reportStatus(win, "download-failed", `${filename} came down the wrong size — retry the download`);
        return;
      }
      const actual = await hashFile(destPath, v.algo, v.encoding);
      if (actual.toLowerCase() !== v.expected.toLowerCase()) {
        // A corrupted or swapped artifact — never hand this to the OS to run.
        logUpdate(`checksum mismatch for ${filename} (${v.source}): expected ${v.expected.slice(0, 12)}… got ${actual.slice(0, 12)}…`);
        fs.rmSync(destPath, { force: true });
        pendingInstallerPath = null;
        reportStatus(win, "download-failed", "the downloaded update failed its integrity check — retry the download");
        return;
      }
      logUpdate(`checksum verified for ${filename} (${v.source})`);
    }

    pendingInstallerPath = destPath;
    if (!win.isDestroyed()) win.webContents.send("update-downloaded");
  } catch (err) {
    pendingInstallerPath = null;
    reportStatus(win, "download-failed", reasonOf(err));
  } finally {
    downloadInFlight = false;
  }
}

// Launch after 5 s, then every 6 h, and again whenever the window regains focus —
// an app left open for days was the main reason people never saw the banner.
function scheduleUpdateChecks(win: BrowserWindow) {
  if (isDev) return;
  setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) void checkForUpdate(mainWindow, { force: true }); }, 5000);
  if (!updateCheckTimer) {
    updateCheckTimer = setInterval(() => {
      if (mainWindow && !mainWindow.isDestroyed()) void checkForUpdate(mainWindow, { force: true });
    }, UPDATE_CHECK_INTERVAL_MS);
  }
  win.on("focus", () => { if (!win.isDestroyed()) void checkForUpdate(win); });
}

// ─── Is a session live right now? ────────────────────────────────────────────
// The renderer owns the WebRTC state, so main asks it. A dead or wedged renderer
// must not block an update forever: no answer inside 1 s counts as not live.
function askRendererCallLive(win: BrowserWindow): Promise<boolean> {
  return new Promise((resolve) => {
    const onReply = (_event: Electron.IpcMainEvent, live: unknown) => {
      clearTimeout(timer);
      resolve(live === true);
    };
    const timer = setTimeout(() => {
      ipcMain.removeListener("call-live-reply", onReply);
      resolve(false);
    }, 1000);
    ipcMain.once("call-live-reply", onReply);
    win.webContents.send("check-call-live");
  });
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

// A refused old build (412 update_required) asks for the banner right away
// instead of waiting for the next scheduled check.
ipcMain.on("check-for-update", () => {
  if (mainWindow && !mainWindow.isDestroyed()) void checkForUpdate(mainWindow, { force: true });
});

// ─── IPC: quit and run the downloaded installer ───────────────────────────────
// Windows: launch the NSIS installer and let it replace the app.
// macOS: a DMG cannot overwrite a running app on its own, and an unsigned app
// has to be approved by the user anyway — so mount the DMG and show the drag
// steps instead of silently opening a Finder window.
ipcMain.on("quit-and-install", async () => {
  if (!pendingInstallerPath) return;
  const installer = pendingInstallerPath;

  if (mainWindow && !mainWindow.isDestroyed() && await askRendererCallLive(mainWindow)) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "You are live on a call",
      message: "Installing now would drop the call",
      detail:
        "Stream Live is in the middle of a session.\n\n" +
        "Finish or leave the call first, then press Install & Restart again — " +
        "the update is already downloaded and will wait for you.",
      buttons: ["Not now", "Install anyway"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1) return;
  }

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
    void handleLegacyInstallerUrl(mainWindow, url);
  } else {
    shell.openExternal(url).catch(() => {});
  }
});

// v1.4.0's renderer asked the OS to open the installer download page; the legacy
// flow bypasses checkForUpdate, so the checksum is resolved from the tag in the URL.
async function handleLegacyInstallerUrl(win: BrowserWindow, url: string) {
  latestDownloadUrl = url;
  let tag = "";
  let filename = "";
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const downloadAt = segments.indexOf("download");
    if (downloadAt >= 0) tag = segments[downloadAt + 1] ?? "";
    filename = decodeURIComponent(segments[segments.length - 1] ?? "");
  } catch {
    logUpdate(`could not parse the installer URL from the update link`);
  }

  const versionFromName = /^(?:StreamLive-Setup-|StreamLive-)([0-9][0-9a-zA-Z.\-]*)/.exec(filename);
  latestVersion = tag ? tag.replace(/^v/, "") : versionFromName?.[1] ?? "latest";
  win.webContents.send("update-available", { version: latestVersion });

  pendingVerification = tag ? await resolveVerification(tag, { name: filename }) : null;
  await startInAppDownload(win, url);
}

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
          // the two video relay hosts, the GitHub updater, and blob/data. rest.fal.ai is
          // gone — the gateway mints the token now, so the renderer must never reach a
          // key endpoint. Both video hosts stay on the list because either pipeline can
          // serve a call, and a page that cannot open its signalling socket just hangs.
          // localhost stays for the dev server and the app's own local API server.
          // Every Decart subdomain is needed, not just the API: the signalling socket on
          // api3 only hands back the media room, and that lives on a regional
          // <region>.lkc.decart.ai host the app cannot predict. Listing api3 alone made
          // every trial call die at "could not establish signal connection".
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://*.fal.ai wss://*.fal.ai https://wma.fal.run https://fal.run wss://fal.run https://*.fal.run wss://*.fal.run https://*.decart.ai wss://*.decart.ai https://fonts.googleapis.com https://fonts.gstatic.com; media-src *; connect-src 'self' http://localhost:* ws://localhost:* https://onhanfathvfkkliayvrn.supabase.co wss://onhanfathvfkkliayvrn.supabase.co https://*.fal.run wss://*.fal.run https://fal.run wss://fal.run https://*.decart.ai wss://*.decart.ai https://api.github.com https://objects.githubusercontent.com data: blob:;",
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

  // Update checks: at launch, then on a schedule and on every window focus.
  mainWindow.webContents.once("did-finish-load", () => {
    if (!isDev && mainWindow) scheduleUpdateChecks(mainWindow);
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

// ─── One copy at a time ────────────────────────────────────────────────────────
// An update is installed over a running app, so the new copy can boot while the old
// one is still alive. Both read the same stored sign-in, and the ticket that trades it
// for a fresh one is only spendable once: whichever copy loses ends up presenting a
// token the server no longer accepts, and the account cannot be read until the customer
// signs out and back in. A second launch only wakes the window that is already open.
const holdsSingleInstanceLock = app.requestSingleInstanceLock();
if (!holdsSingleInstanceLock) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  if (!holdsSingleInstanceLock) return;
  createWindow();
  showMacFirstLaunchNotice();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (updateCheckTimer) { clearInterval(updateCheckTimer); updateCheckTimer = null; }
  shutdownVirtualCamera();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  shutdownVirtualCamera();
});
