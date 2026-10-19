import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("isElectron", true);

contextBridge.exposeInMainWorld("electronAPI", {
  // Update available notification
  onUpdateAvailable: (
    callback: (info: { version: string }) => void
  ) => {
    ipcRenderer.on("update-available", (_event, info) => callback(info));
  },

  // Download progress (0–100)
  onDownloadProgress: (
    callback: (info: { percent: number; transferred: number; total: number }) => void
  ) => {
    ipcRenderer.on("download-progress", (_event, info) => callback(info));
  },

  // Update fully downloaded — ready to install
  onUpdateDownloaded: (callback: () => void) => {
    ipcRenderer.on("update-downloaded", () => callback());
  },

  // Why an update check or a download did not work — { kind, message }
  onUpdateStatus: (
    callback: (info: { kind: "check-failed" | "download-failed" | "ok"; message?: string }) => void
  ) => {
    ipcRenderer.on("update-status", (_event, info) => callback(info));
  },

  // Main asks before installing: reply true only while a session is live, so an
  // update never drops a call.
  onCheckCallLive: (callback: (reply: (live: boolean) => void) => void) => {
    ipcRenderer.on("check-call-live", () => {
      try {
        callback((live: boolean) => ipcRenderer.send("call-live-reply", live === true));
      } catch {
        ipcRenderer.send("call-live-reply", false);
      }
    });
  },

  // Ask GitHub for an update now (used when the gateway refuses an old build)
  checkForUpdate: () => {
    ipcRenderer.send("check-for-update");
  },

  // Open the till in a window of the app's own. The address is never shown to the
  // customer; it comes from the gateway and is checked in the main process first.
  openCheckout: (page: string): void => {
    if (typeof page === "string" && page) ipcRenderer.send("open-checkout", page);
  },

  // Trigger the download
  downloadUpdate: () => {
    ipcRenderer.send("download-update");
  },

  // The till came back to the seller's page with an order: worth reading the meter again.
  onCheckoutReceipt: (callback: () => void) => {
    ipcRenderer.on("checkout-receipt", () => callback());
  },

  // Quit and install the downloaded update
  quitAndInstall: () => {
    ipcRenderer.send("quit-and-install");
  },

  // Stable per-machine id the gateway binds metered leases to
  getDeviceId: (): Promise<string> => {
    return ipcRenderer.invoke("get-device-id");
  },

  // One line in account.log — the reason something failed, never a credential
  logNote: (note: string): void => {
    ipcRenderer.send("app-note", note);
  },

  // ─── Virtual camera ("Stream Live Camera") frame feeder ───────────────────
  vcamStart: (): Promise<{ supported: boolean; active: boolean; ready: boolean; error: string | null }> =>
    ipcRenderer.invoke("vcam-start"),
  vcamStop: (): Promise<{ supported: boolean; active: boolean; ready: boolean; error: string | null }> =>
    ipcRenderer.invoke("vcam-stop"),
  vcamStatus: (): Promise<{ supported: boolean; active: boolean; ready: boolean; error: string | null; cameraName: string }> =>
    ipcRenderer.invoke("vcam-status"),
  // High-frequency RGBA8 frame push (fire-and-forget)
  vcamFrame: (buf: ArrayBuffer, width: number, height: number): void => {
    ipcRenderer.send("vcam-frame", buf, width, height);
  },
});
