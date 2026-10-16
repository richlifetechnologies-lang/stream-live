import { useState } from "react";
import { Apple, Check, Copy, Download } from "lucide-react";
import { CABLE_NAME, IS_MAC } from "../lib/platform";

const C = "hsl(187 100% 52%)";
const VC = "hsl(265 90% 65%)";

const QUARANTINE_CMD = 'xattr -dr com.apple.quarantine "/Applications/Stream Live.app"';

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: "50%", background: "hsl(187 100% 52% / 0.12)", border: `1px solid ${C}55`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: C, fontFamily: "'Orbitron',monospace" }}>
        {n}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif", marginBottom: 4 }}>{title}</p>
        <div style={{ fontSize: 12.5, color: "hsl(222 25% 62%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.65 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function Cmd() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(QUARANTINE_CMD)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); })
      .catch(() => { /* clipboard is unavailable outside a secure context */ });
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, padding: "8px 10px", background: "hsl(222 47% 3%)", border: "1px solid hsl(222 40% 14%)", borderRadius: 8 }}>
      <code style={{ flex: 1, minWidth: 0, fontSize: 11, color: "hsl(143 72% 60%)", fontFamily: "monospace", overflowWrap: "anywhere" }}>{QUARANTINE_CMD}</code>
      <button onClick={copy}
        style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 9px", borderRadius: 7, flexShrink: 0, cursor: "pointer", background: copied ? "hsl(143 72% 40% / 0.18)" : "hsl(222 40% 11%)", border: `1px solid ${copied ? "hsl(143 72% 55% / 0.5)" : "hsl(222 40% 18%)"}`, color: copied ? "hsl(143 72% 60%)" : "hsl(222 25% 55%)", fontSize: 10.5, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif" }}>
        {copied ? <Check style={{ width: 11, height: 11 }} /> : <Copy style={{ width: 11, height: 11 }} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function GetApp({ name, href, why }: { name: string; href: string; why: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer"
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", background: "hsl(222 40% 8%)", border: "1px solid hsl(222 40% 14%)", borderRadius: 9, textDecoration: "none" }}>
      <Download style={{ width: 14, height: 14, color: C, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif" }}>{name}</span>
        <span style={{ display: "block", fontSize: 11, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif" }}>{why}</span>
      </span>
      <span style={{ fontSize: 10, fontWeight: 700, color: C, fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em", flexShrink: 0 }}>GET</span>
    </a>
  );
}

/**
 * The Mac route to a call app: BlackHole carries your voice, OBS carries the
 * AI picture. Windows bundles both as drivers; macOS refuses an unapproved
 * system camera extension, so the two helpers are installed by the user.
 */
export function MacSetupCard() {
  if (!IS_MAC) return null;
  return (
    <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 20, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <Apple style={{ width: 15, height: 15, color: C }} />
        <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron', monospace" }}>
          Mac Setup
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <Step n={1} title="Approve the app in System Settings — once">
          <p>
            Stream Live isn't signed with a paid Apple Developer certificate, so Gatekeeper refuses the
            first launch. Open the app once, then go to <b style={{ color: "hsl(190 80% 90%)" }}>System Settings → Privacy &amp; Security</b>,
            scroll to Security and click <b style={{ color: "hsl(190 80% 90%)" }}>“Open Anyway”</b> beside
            “Stream Live was blocked”. Enter your password and launch it again — it stays approved.
          </p>
          <p style={{ marginTop: 6 }}>If “Open Anyway” never appears, quit the app and run this in Terminal:</p>
          <Cmd />
        </Step>

        <Step n={2} title="Allow the camera and the microphone">
          <p>
            In <b style={{ color: "hsl(190 80% 90%)" }}>System Settings → Privacy &amp; Security</b>, switch{" "}
            <b style={{ color: "hsl(190 80% 90%)" }}>Stream Live</b> on under both <b style={{ color: "hsl(190 80% 90%)" }}>Camera</b> and{" "}
            <b style={{ color: "hsl(190 80% 90%)" }}>Microphone</b>. Without them the preview stays black and no voice is cloned.
          </p>
        </Step>

        <Step n={3} title="Install the two free helpers">
          <p style={{ marginBottom: 8 }}>
            They do the job the bundled Windows drivers do: one carries sound, one carries video.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <GetApp href="https://existential.audio/blackhole/" name="BlackHole 2ch" why="A silent virtual speaker — your voice goes in here" />
            <GetApp href="https://obsproject.com/" name="OBS Studio" why="Turns the Stream Live window into a webcam" />
          </div>
          <p style={{ marginTop: 8 }}>
            After installing BlackHole, log out and back in. It then shows up under System Settings → Sound,
            and in the “Audio out” dropdown on the stream screen.
          </p>
        </Step>

        <Step n={4} title="Put the AI feed into a call">
          <p style={{ marginBottom: 6 }}>
            On the stream screen, open the <b style={{ color: "hsl(190 80% 90%)" }}>OBS</b> window and turn{" "}
            <b style={{ color: VC }}>Stream Live Microphone</b> on — the cloned voice moves to {CABLE_NAME}.
          </p>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            <li>In OBS: Sources → + → <b style={{ color: "hsl(190 80% 90%)" }}>Window Capture</b> → “Stream Live OBS”.</li>
            <li>In OBS: Controls → <b style={{ color: "hsl(190 80% 90%)" }}>Start Virtual Camera</b>.</li>
            <li>In Zoom / Teams / Meet: Camera → <b style={{ color: C }}>OBS Virtual Camera</b>, Microphone → <b style={{ color: VC }}>{CABLE_NAME}</b>.</li>
          </ol>
          <p style={{ marginTop: 6 }}>
            The app puts your voice into {CABLE_NAME} itself, so the call app hears you as well as seeing the
            picture. Wear headphones: with loudspeakers the call comes straight back out of your microphone.
          </p>
        </Step>
      </div>

      <p style={{ marginTop: 16, paddingTop: 12, borderTop: "1px dashed hsl(222 40% 14%)", fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.6 }}>
        OBS Virtual Camera carries picture only — that is why the call app must take its microphone from {CABLE_NAME}.
        Signing and notarizing Stream Live would remove step 1; it would not remove OBS, because macOS only accepts a
        system webcam from an app Apple has approved with a system-extension entitlement.
      </p>
    </div>
  );
}
