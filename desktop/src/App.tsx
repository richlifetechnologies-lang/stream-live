import { Router, Route, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useState, useEffect } from "react";
import StreamPage from "./pages/stream";
import SettingsPage from "./pages/settings";
import UsagePage from "./pages/usage";
import MinutesPage from "./pages/minutes";
import PlansPage from "./pages/plans";
import AccountPage from "./pages/account";
import PopoutPage from "./pages/popout";
import ObsoutPage from "./pages/obsout";
import ObsoutPortraitPage from "./pages/obsoutp";
import Toaster from "./components/toaster";
import StatusBanner from "./components/status-banner";
import { ArtBackdrop } from "./components/brand";
import { useAccount, restore, getState, notePaymentReceipt } from "./lib/gateway";

const C = "hsl(187 100% 52%)";
const ERR = "hsl(0 80% 62%)";
const BG = "hsl(222 47% 4%)";

type UpdateStatus = { kind: "check-failed" | "download-failed" | "ok"; message?: string };

declare global {
  interface Window {
    isElectron?: boolean;
    __slRemoteStream?: MediaStream | null;
    electronAPI?: {
      onUpdateAvailable: (cb: (info: { version: string }) => void) => void;
      onDownloadProgress: (cb: (info: { percent: number; transferred: number; total: number }) => void) => void;
      onUpdateDownloaded: (cb: () => void) => void;
      onUpdateStatus?: (cb: (info: UpdateStatus) => void) => void;
      onCheckCallLive?: (cb: (reply: (live: boolean) => void) => void) => void;
      onCheckoutReceipt?: (cb: () => void) => void;
      downloadUpdate: () => void;
      quitAndInstall: () => void;
    };
  }
}

// The installer must not quit an on-air session. The peer stream is the ground
// truth; the metered lease is the backstop for a call still negotiating.
function isCallLive(): boolean {
  if (window.__slRemoteStream?.active) return true;
  return getState().live !== null;
}

type UpdateState = "available" | "downloading" | "downloaded" | "failed";

function UpdateBanner() {
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<UpdateState>("available");
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    window.electronAPI?.onUpdateAvailable((info) => {
      setVersion(info.version);
      setState("available");
      setError(null);
      setDismissed(false);
    });
    window.electronAPI?.onDownloadProgress((info) => {
      setState("downloading");
      setError(null);
      setPercent(info.percent);
    });
    window.electronAPI?.onUpdateDownloaded(() => {
      setState("downloaded");
      setError(null);
      setPercent(100);
    });
    window.electronAPI?.onUpdateStatus?.((info) => {
      if (info.kind !== "download-failed") return;
      setState("failed");
      setError(info.message ?? "the download could not be completed");
    });
  }, []);

  if (!version || dismissed) return null;

  const handleDownload = () => {
    setState("downloading");
    setPercent(0);
    setError(null);
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
          background: state === "failed" ? "hsl(0 80% 62% / 0.15)" : "hsl(187 100% 52% / 0.15)",
          border: `1px solid ${state === "failed" ? ERR : C}44`,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {state === "downloaded" ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 7l4 4 6-6" stroke={C} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : state === "failed" ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 2v6M7 11h.01" stroke={ERR} strokeWidth="1.8" strokeLinecap="round"/>
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
                Stream Live v{version} — download and install automatically
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
          {state === "failed" && (
            <>
              <span style={{ fontSize: 12, fontWeight: 700, color: ERR, fontFamily: "'Orbitron', monospace", letterSpacing: "0.06em" }}>
                Download failed
              </span>
              <span style={{ fontSize: 12, color: "hsl(222 25% 65%)", fontFamily: "'Rajdhani', sans-serif", marginLeft: 8 }}>
                {error}
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
        {state === "failed" && (
          <button onClick={handleDownload} style={{
            padding: "6px 16px", borderRadius: 7,
            background: ERR, border: "none", cursor: "pointer",
            color: "hsl(222 47% 4%)", fontSize: 11, fontWeight: 700,
            fontFamily: "'Orbitron', monospace", letterSpacing: "0.06em",
            boxShadow: `0 0 16px hsl(0 80% 62% / 0.3)`,
          }}>
            Retry
          </button>
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

function Splash() {
  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: BG }}>
      <ArtBackdrop />
      <div style={{
        position: "relative", height: "100%", display: "flex", alignItems: "flex-end",
        justifyContent: "center", paddingBottom: "7vh",
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "9px 18px", borderRadius: 999,
          background: "hsl(228 62% 4% / 0.86)", backdropFilter: "blur(16px)",
          border: "1px solid hsl(187 100% 52% / 0.22)",
          boxShadow: "0 12px 40px hsl(226 80% 2% / 0.55)",
        }}>
          <div style={{
            width: 14, height: 14, borderRadius: "50%",
            border: `2px solid ${C}33`, borderTopColor: C,
            animation: "ss-spin 0.8s linear infinite",
          }} />
          <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 11, letterSpacing: "0.14em", color: "hsl(187 100% 74%)" }}>
            CONNECTING…
          </span>
        </div>
      </div>
      <style>{`@keyframes ss-spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// The stream tab is account-gated: no session means sign-in, never the console.
// OBS output windows (popout/obsout) are separate processes and stay ungated.
function StreamGate() {
  const account = useAccount();
  if (account.loading) return <Splash />;
  if (!account.signedIn) return <AccountPage />;
  return <StreamPage />;
}

export default function App() {
  useEffect(() => { void restore(); }, []);

  // The updater asks before it quits, so installing can't drop a live call.
  useEffect(() => {
    window.electronAPI?.onCheckCallLive?.((reply) => reply(isCallLive()));
  }, []);

  // The payment window came back to the till with an order in its address: look at the
  // meter now. The credit itself is the server's doing, never this screen's.
  useEffect(() => {
    window.electronAPI?.onCheckoutReceipt?.(() => notePaymentReceipt());
  }, []);

  return (
    <Router hook={useHashLocation}>
      <Toaster />
      <UpdateBanner />
      <StatusBanner />
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
        <Route path="/minutes">
          <MinutesPage />
        </Route>
        <Route path="/plans">
          <PlansPage />
        </Route>
        <Route path="/settings">
          <SettingsPage />
        </Route>
        <Route path="/account">
          <AccountPage />
        </Route>
        <Route>
          <StreamGate />
        </Route>
      </Switch>
    </Router>
  );
}
