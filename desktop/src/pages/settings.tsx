import { AppLayout } from "../components/layout";
import { MacSetupCard } from "../components/mac-setup";
import { useLocation, Link } from "wouter";
import { User, Wallet, LogOut, Trash2, ArrowRight, Compass } from "lucide-react";
import { clearCredentials } from "../lib/credentials";
import { useAccount, signOut } from "../lib/gateway";
import { requestTour, useTourSeen } from "../components/guided-tour";
import { countdown } from "../lib/minutes";
import { useToast } from "../hooks/use-toast";
import type { Modality } from "@stream-live/client";

const C = "hsl(187 100% 52%)";
const BG = "hsl(222 47% 4%)";

const MOD_LABELS: Record<Modality, string> = {
  video: "Video Call",
  audio: "Audio Call",
  video_audio: "Video + Audio",
};

function balanceText(m: number | null, unlimited: boolean) {
  if (unlimited) return "Unlimited";
  return countdown(m ?? 0);
}

export default function SettingsPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const account = useAccount();
  const seen = useTourSeen();

  // The tour lives on the stream screen, because that is where the panels are.
  const handleTour = () => { requestTour(); setLocation("/"); };

  const handleClearVoices = () => {
    if (!confirm("Remove your saved voices from this device?")) return;
    clearCredentials();
    toast({ title: "Saved voices cleared" });
  };

  const handleSignOut = async () => {
    await signOut();
    setLocation("/account");
  };

  return (
    <AppLayout>
      <div style={{ padding: 32, maxWidth: 640 }}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontFamily: "'Orbitron', monospace", fontWeight: 700, fontSize: 20, letterSpacing: "0.06em", color: "hsl(190 80% 96%)", marginBottom: 4 }}>
            Settings
          </h1>
          <p style={{ color: "hsl(222 25% 50%)", fontSize: 14, fontFamily: "'Rajdhani', sans-serif" }}>
            Your account, minutes and device
          </p>
        </div>

        {/* ── Account ──────────────────────────────────────────────────────── */}
        <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 20, marginBottom: 14 }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron', monospace", marginBottom: 14 }}>
            Account
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "hsl(222 40% 8%)", borderRadius: 8, border: "1px solid hsl(222 40% 12%)", marginBottom: 12 }}>
            <User style={{ width: 14, height: 14, color: C, flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: "hsl(190 80% 90%)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {account.email ?? "Not signed in"}
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
            {account.wallets.map(w => (
              <div key={w.modality} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", background: "hsl(222 40% 8%)", borderRadius: 8, border: "1px solid hsl(222 40% 12%)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "hsl(222 25% 60%)", fontFamily: "'Rajdhani', sans-serif" }}>
                  <Wallet style={{ width: 13, height: 13, color: C }} /> {MOD_LABELS[w.modality]}
                </span>
                <span style={{ fontSize: 13, color: "hsl(190 80% 96%)", fontFamily: "'Orbitron', monospace", fontWeight: 700 }}>{balanceText(w.balance, w.unlimited)}</span>
              </div>
            ))}
          </div>

          <Link href="/minutes">
            <a style={{ display: "flex", alignItems: "center", gap: 6, width: "fit-content", padding: "10px 18px", borderRadius: 8, background: C, color: BG, fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani', sans-serif", cursor: "pointer", textDecoration: "none" }}>
              Open minutes dashboard <ArrowRight style={{ width: 14, height: 14 }} />
            </a>
          </Link>
          <p style={{ fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani', sans-serif", lineHeight: 1.5, marginTop: 10 }}>
            Stream Live is account-gated — the service keys are managed by your administrator and never entered here.
          </p>
        </div>

        {/* ── Walk-through ─────────────────────────────────────────────────── */}
        <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 20, marginBottom: 14 }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron', monospace", marginBottom: 10 }}>
            Walk-through
          </p>
          <p style={{ fontSize: 13, color: "hsl(222 25% 62%)", fontFamily: "'Rajdhani', sans-serif", lineHeight: 1.6, marginBottom: 14 }}>
            A short tour of the Video Call tab — the camera, the style, the reference photo,
            where your free minute sits and the Start button.{' '}
            Every new computer gets it once, half a minute long.{' '}
            {seen ? "This computer has already been through it." : "This computer hasn't been through it yet."}
          </p>
          <button onClick={handleTour}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 8, background: C, border: "none", color: BG, fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani', sans-serif", cursor: "pointer" }}>
            <Compass style={{ width: 14, height: 14 }} /> Walk me through the app
          </button>
        </div>

        {/* ── Mac output path ──────────────────────────────────────────────── */}        <MacSetupCard />

        {/* ── Danger zone ──────────────────────────────────────────────────── */}
        <div style={{ background: "hsl(0 60% 7%)", border: "1px solid hsl(0 85% 40% / 0.25)", borderRadius: 14, padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Trash2 style={{ width: 15, height: 15, color: "hsl(0 85% 65%)" }} />
            <p style={{ fontWeight: 700, fontSize: 14, color: "hsl(0 85% 75%)", fontFamily: "'Rajdhani', sans-serif" }}>Danger Zone</p>
          </div>
          <p style={{ fontSize: 13, color: "hsl(0 50% 60%)", marginBottom: 14, fontFamily: "'Rajdhani', sans-serif", lineHeight: 1.5 }}>
            Clear the voices saved on this device, or sign out.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={handleClearVoices}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 8, background: "hsl(0 85% 40% / 0.2)", border: "1px solid hsl(0 85% 40% / 0.4)", cursor: "pointer", color: "hsl(0 85% 70%)", fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani', sans-serif" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.35)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.2)"; }}>
              <Trash2 style={{ width: 13, height: 13 }} /> Clear Saved Voices
            </button>
            <button onClick={handleSignOut}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 8, background: "hsl(0 85% 40% / 0.2)", border: "1px solid hsl(0 85% 40% / 0.4)", cursor: "pointer", color: "hsl(0 85% 70%)", fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani', sans-serif" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.35)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.2)"; }}>
              <LogOut style={{ width: 13, height: 13 }} /> Sign Out
            </button>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
