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

  // Trigger the download
  downloadUpdate: () => {
    ipcRenderer.send("download-update");
  },

  // Quit and install the downloaded update
  quitAndInstall: () => {
    ipcRenderer.send("quit-and-install");
  },

  // Mint a short-lived fal.ai JWT in the Main Process (keeps API key off renderer)
  getFalToken: (apiKey: string, appId: string): Promise<string> => {
    return ipcRenderer.invoke("get-fal-token", apiKey, appId);
  },

  // ─── Virtual camera ("Stream Studio Camera") frame feeder ───────────────────
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
