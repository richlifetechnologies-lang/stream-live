import { AppLayout } from "../components/layout"
import { Stage, PageHead, Card, CardTitle, Stat, PrimaryButton, D2 } from "../components/d2";
import { MacSetupCard } from "../components/mac-setup";
import { useLocation } from "wouter";
import { User, LogOut, Trash2, ArrowRight, Compass } from "lucide-react";
import { clearCredentials } from "../lib/credentials";
import { useAccount, signOut } from "../lib/gateway";
import { requestTour, useTourSeen } from "../components/guided-tour";
import { countdown } from "../lib/minutes";
import { t } from "../lib/i18n";
import { useToast } from "../hooks/use-toast";
import type { Modality } from "@stream-live/client";

const RED = "hsl(0 85% 40%)";

const MOD_LABELS: Record<Modality, string> = {
  video: "Video Call",
  audio: "Audio Call",
  video_audio: "Video + Audio",
};

function balanceText(m: number | null, unlimited: boolean) {
  if (unlimited) return t("Unlimited");
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
    if (!confirm(t("Remove your saved voices from this device?"))) return;
    clearCredentials();
    toast({ title: t("Saved voices cleared") });
  };

  const handleSignOut = async () => {
    await signOut();
    setLocation("/account");
  };

  return (
    <AppLayout>
      <Stage>
        <div style={{ padding: "0 0 40px", maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
          <PageHead
            name="Settings"
            note="Your account, minutes and device"
            card={account.wallets.length > 0 ? (
              <Card pad={16} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {account.wallets.map(w => (
                  <Stat key={w.modality} label={MOD_LABELS[w.modality]} value={balanceText(w.balance, w.unlimited)} accent={D2} />
                ))}
              </Card>
            ) : undefined}
          />

          {/* ── Account ──────────────────────────────────────────────────────── */}
          <Card pad={20}>
            <CardTitle>{t("Account")}</CardTitle>

            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "hsl(222 40% 8%)", borderRadius: 8, border: "1px solid hsl(222 40% 12%)", marginBottom: 14 }}>
              <User style={{ width: 14, height: 14, color: D2, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: "hsl(190 80% 90%)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {account.email ?? t("Not signed in")}
              </span>
            </div>

            <PrimaryButton onClick={() => setLocation("/minutes")}>
              {t("Open minutes dashboard")} <ArrowRight style={{ width: 14, height: 14 }} />
            </PrimaryButton>
            <p style={{ fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani', sans-serif", lineHeight: 1.5, marginTop: 10 }}>
              {t("Stream Live is account-gated — the service keys are managed by your administrator and never entered here.")}
            </p>
          </Card>

          {/* ── Walk-through ─────────────────────────────────────────────────── */}
          <Card pad={20}>
            <CardTitle>{t("Walk-through")}</CardTitle>
            <p style={{ fontSize: 13, color: "hsl(222 25% 62%)", fontFamily: "'Rajdhani', sans-serif", lineHeight: 1.6, marginBottom: 14 }}>
              {t("A short tour of the Video Call tab — the camera, the style, the reference photo, where your free minute sits and the Start button.")}{' '}
              {t("Every new computer gets it once, half a minute long.")}{' '}
              {seen ? t("This computer has already been through it.") : t("This computer hasn't been through it yet.")}
            </p>
            <PrimaryButton onClick={handleTour}>
              <Compass style={{ width: 14, height: 14 }} /> {t("Walk me through the app")}
            </PrimaryButton>
          </Card>

          {/* ── Mac output path ──────────────────────────────────────────────── */}
          <MacSetupCard />

          {/* ── Danger zone ──────────────────────────────────────────────────── */}
          <Card accent={RED} pad={20} style={{ background: "hsl(0 60% 7% / 0.92)", borderColor: "hsl(0 85% 40% / 0.35)", boxShadow: "0 12px 40px hsl(0 80% 2% / 0.5), 0 0 26px hsl(0 85% 40% / 0.08)" }}>
            <CardTitle accent={RED}>
              <Trash2 style={{ width: 12, height: 12, color: RED, verticalAlign: -1, marginRight: 7 }} />
              {t("Danger Zone")}
            </CardTitle>
            <p style={{ fontSize: 13, color: "hsl(0 50% 60%)", marginBottom: 14, fontFamily: "'Rajdhani', sans-serif", lineHeight: 1.5 }}>
              {t("Clear the voices saved on this device, or sign out.")}
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={handleClearVoices}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, background: "hsl(0 85% 40% / 0.2)", border: "1px solid hsl(0 85% 40% / 0.4)", cursor: "pointer", color: "hsl(0 85% 70%)", fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani', sans-serif" }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.35)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.2)"; }}>
                <Trash2 style={{ width: 13, height: 13 }} /> {t("Clear Saved Voices")}
              </button>
              <button onClick={handleSignOut}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, background: "hsl(0 85% 40% / 0.2)", border: "1px solid hsl(0 85% 40% / 0.4)", cursor: "pointer", color: "hsl(0 85% 70%)", fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani', sans-serif" }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.35)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.2)"; }}>
                <LogOut style={{ width: 13, height: 13 }} /> {t("Sign Out")}
              </button>
            </div>
          </Card>
        </div>
      </Stage>
    </AppLayout>
  );
}
