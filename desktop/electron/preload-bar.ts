// The one thing this line needs from the app: the words. It is given no other door - no files,
// no network, no account - because a bar that only ever displays has nothing to be tricked into.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("slBar", {
  onLine: (callback: (line: { chip: string; text: string; asSaid: string }) => void) => {
    ipcRenderer.on("bar-line", (_event, line) => callback(line));
  },
});
