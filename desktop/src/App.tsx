import { Router, Route, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useState, useEffect } from "react";
import StreamPage from "./pages/stream";
import SettingsPage from "./pages/settings";
import UsagePage from "./pages/usage";
import PopoutPage from "./pages/popout";
import ObsoutPage from "./pages/obsout";
import ObsoutPortraitPage from "./pages/obsoutp";
import Toaster from "./components/toaster";

const C = "hsl(187 100% 52%)";

declare global {
  interface Window {
    isElectron?: boolean;
    __ssRemoteStream?: MediaStream | null;
    electronAPI?: {
      onUpdateAvailable: (cb: (info: { version: string }) => void) => void;
      onDownloadProgress: (cb: (info: { percent: number; transferred: number; total: number }) => void) => void;
      onUpdateDownloaded: (cb: () => void) => void;
      downloadUpdate: () => void;
      quitAndInstall: () => void;
    };
  }
}

type UpdateState = "available" | "downloading" | "downloaded";

function UpdateBanner() {
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<UpdateState>("available");
  const [percent, setPercent] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    window.electronAPI?.onUpdateAvailable((info) => {
      setVersion(info.version);
    });
    window.electronAPI?.onDownloadProgress((info) => {
      setState("downloading");
      setPercent(info.percent);
    });
    window.electronAPI?.onUpdateDownloaded(() => {
      setState("downloaded");
      setPercent(100);
    });
  }, []);

  if (!version || dismissed) return null;

  const handleDownload = () => {
    setState("downloading");
    window.electronAPI?.downloadUpdate();
  };

  const handleInstall = () => {
    window.electronAPI?.quitAndInstall();
  };

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 12, padding: "10px 20px",
      background: "linear-gradient(90deg, hsl(222 50% 6%) 0%, hsl(222 50% 8%) 100%)",
      borderBottom: `1px solid ${C}44`,
      boxShadow: `0 0 24px hsl(187 100% 52% / 0.12)`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8, flexShrink: 0,
          background: "hsl(187 100% 52% / 0.15)", border: `1px solid ${C}44`,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {state === "downloaded" ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 7l4 4 6-6" stroke={C} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke={C} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {state === "available" && (
            <>
              <span style={{ fontSize: 12, fontWeight: 700, color: C, fontFamily: "'Orbitron', monospace", letterSpacing: "0.06em" }}>
                Update Available
              </span>
              <span style={{ fontSize: 12, color: "hsl(222 25% 65%)", fontFamily: "'Rajdhani', sans-serif", marginLeft: 8 }}>
                Stream Studio v{version} — download and install automatically
              </span>
            </>
          )}
          {state === "downloading" && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: C, fontFamily: "'Orbitron', monospace", letterSpacing: "0.06em", flexShrink: 0 }}>
                Downloading v{version}…
              </span>
              <div style={{ flex: 1, maxWidth: 200, height: 5, background: "hsl(222 40% 12%)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 3,
                  width: `${percent}%`,
                  background: `linear-gradient(90deg, ${C}, hsl(200 100% 45%))`,
                  transition: "width 0.3s ease",
                  boxShadow: `0 0 8px hsl(187 100% 52% / 0.5)`,
                }} />
              </div>
              <span style={{ fontSize: 11, color: C, fontFamily: "'Orbitron', monospace", fontWeight: 700, flexShrink: 0 }}>
                {percent}%
              </span>
            </div>
          )}
          {state === "downloaded" && (
            <>
              <span style={{ fontSize: 12, fontWeight: 700, color: C, fontFamily: "'Orbitron', monospace", letterSpacing: "0.06em" }}>
                v{version} Ready
              </span>
              <span style={{ fontSize: 12, color: "hsl(222 25% 65%)", fontFamily: "'Rajdhani', sans-serif", marginLeft: 8 }}>
                Update downloaded — restart to apply
              </span>
            </>
          )}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {state === "available" && (
          <button onClick={handleDownload} style={{
            padding: "6px 16px", borderRadius: 7,
            background: C, border: "none", cursor: "pointer",
            color: "hsl(222 47% 4%)", fontSize: 11, fontWeight: 700,
            fontFamily: "'Orbitron', monospace", letterSpacing: "0.06em",
            boxShadow: `0 0 16px hsl(187 100% 52% / 0.3)`,
            transition: "filter 0.15s",
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.filter = "brightness(1.1)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = "none"; }}
          >
            Download
          </button>
        )}
        {state === "downloading" && (
          <div style={{
            padding: "6px 14px", borderRadius: 7,
            background: "hsl(222 40% 11%)", border: "1px solid hsl(222 40% 18%)",
            color: "hsl(222 25% 50%)", fontSize: 11, fontWeight: 700,
            fontFamily: "'Rajdhani', sans-serif",
          }}>
            Downloading…
          </div>
        )}
        {state === "downloaded" && (
          <button onClick={handleInstall} style={{
            padding: "6px 16px", borderRadius: 7,
            background: C, border: "none", cursor: "pointer",
            color: "hsl(222 47% 4%)", fontSize: 11, fontWeight: 700,
            fontFamily: "'Orbitron', monospace", letterSpacing: "0.06em",
            boxShadow: `0 0 16px hsl(187 100% 52% / 0.4)`,
            transition: "filter 0.15s",
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.filter = "brightness(1.1)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = "none"; }}
          >
            Install & Restart
          </button>
        )}
        {state !== "downloading" && (
          <button onClick={() => setDismissed(true)} style={{
            padding: "6px 10px", borderRadius: 7,
            background: "hsl(222 40% 11%)", border: "1px solid hsl(222 40% 18%)",
            cursor: "pointer", color: "hsl(222 25% 50%)",
            fontSize: 11, fontWeight: 700, fontFamily: "'Rajdhani', sans-serif",
            transition: "all 0.15s",
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "hsl(222 25% 70%)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "hsl(222 25% 50%)"; }}
          >
            Later
          </button>
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Router hook={useHashLocation}>
      <Toaster />
      <UpdateBanner />
      <Switch>
        <Route path="/popout">
          <PopoutPage />
        </Route>
        <Route path="/obsout">
          <ObsoutPage />
        </Route>
        <Route path="/obsout-portrait">
          <ObsoutPortraitPage />
        </Route>
        <Route path="/usage">
          <UsagePage />
        </Route>
        <Route path="/settings">
          <SettingsPage />
        </Route>
        <Route>
          <StreamPage />
        </Route>
      </Switch>
    </Router>
  );
}
