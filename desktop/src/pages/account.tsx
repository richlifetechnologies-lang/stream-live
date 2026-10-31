import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { AppLayout } from "../components/layout"
import { Stage, PageHead, Card, CardTitle, Pill, PrimaryButton, D2 } from "../components/d2";
import { ArtBackdrop, Logo } from "../components/brand";
import { useToast } from "../hooks/use-toast";
import { gateway, useAccount, useAdminContact, signIn, signUp, signOut } from "../lib/gateway";
import { GATEWAY_CONFIGURED } from "../lib/gateway-config";
import { toUserMessage } from "../lib/end-reason";
import { ContactLine } from "../components/contact";
import { LanguageMenu } from "../components/lang-menu";
import { t, useLang } from "../lib/i18n";
import { LogIn, LogOut, UserPlus, KeyRound, Loader2, Hourglass, CreditCard } from "lucide-react";

const BG = "hsl(222 47% 4%)";

// Refuses the addresses that cannot exist at all — nothing before the @, a space
// anywhere, a domain with no real ending. It cannot judge a correctly spelled address
// that belongs to nobody: only a link that actually arrives proves an address, which is
// why the account email is worth confirming. The gateway checks this same shape on the
// server, so an older build cannot get past it either.
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;

function emailProblem(value: string): string | null {
  const v = value.trim();
  if (!v) return t("Enter your email address.");
  if (/\s/.test(v)) return t("An email address cannot contain spaces.");
  if (!EMAIL_SHAPE.test(v)) return t("That is not a valid email address. Check for a missing @, a missing dot, or a mistyped ending like “.con”.");
  return null;
}

function fmtDate(ts: string | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const labelSt: React.CSSProperties = { display: "block", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron', monospace", marginBottom: 6, color: "hsl(222 25% 50%)" };
const inputSt: React.CSSProperties = { width: "100%", padding: "9px 12px", background: BG, border: "1px solid hsl(222 40% 14%)", borderRadius: 8, color: "hsl(190 80% 96%)", fontSize: 13, fontFamily: "'Rajdhani', sans-serif", outline: "none" };

export default function AccountPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const account = useAccount();
  const contact = useAdminContact();

  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const [devices, setDevices] = useState<Array<Record<string, unknown>>>([]);
  const [newPassword, setNewPassword] = useState("");
  const [changingPw, setChangingPw] = useState(false);

  const loadDevices = useCallback(async () => {
    try {
      setDevices(await gateway.devices());
    } catch { /* panel stays empty */ }
  }, []);

  useEffect(() => {
    if (account.signedIn) void loadDevices();
  }, [account.signedIn, loadDevices]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!GATEWAY_CONFIGURED) {
      toast({ title: t("Gateway not configured"), description: t("This build was packaged without VITE_SUPABASE_ANON_KEY, so it cannot reach your account."), variant: "destructive" });
      return;
    }
    const badEmail = emailProblem(email);
    if (badEmail) {
      toast({ title: t("Check the email address"), description: badEmail, variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      if (authMode === "signup") {
        const session = await signUp(email.trim(), password, name.trim() || undefined);
        if (!session) {
          toast({ title: t("Account created"), description: t("Your account works immediately — sign in to continue.") });
          setAuthMode("signin");
        } else {
          toast({ title: t("Welcome to Stream Live") });
        }
      } else {
        await signIn(email.trim(), password);
        toast({ title: t("Signed in") });
      }
    } catch (err) {
      toast({ title: authMode === "signup" ? t("Could not create account") : t("Sign-in failed"), description: toUserMessage(err, authMode === "signup" ? t("We couldn't create the account. Try again.") : t("Check your email and password, then try again.")), variant: "destructive" });
    } finally { setBusy(false); }
  };

  const handleChangePassword = async () => {
    if (changingPw) return;
    if (newPassword.length < 6) { toast({ title: t("Use at least 6 characters."), variant: "destructive" }); return; }
    setChangingPw(true);
    try {
      const { error } = await gateway.raw.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setNewPassword("");
      toast({ title: t("Password updated") });
    } catch (err) {
      toast({ title: t("Could not update password"), description: toUserMessage(err, t("We couldn't update your password. Try again.")), variant: "destructive" });
    } finally { setChangingPw(false); }
  };

  const handleSignOut = async () => {
    await signOut();
    setLocation("/account");
  };

  // ── Signed-out: full-screen artwork + auth form ──────────────────────────────
  if (!account.signedIn) {
    const ghost: React.CSSProperties = { width: "100%", padding: "10px 13px", background: "hsl(226 60% 4% / 0.72)", border: "1px solid hsl(187 100% 52% / 0.18)", borderRadius: 9, color: "hsl(190 80% 96%)", fontSize: 14, fontFamily: "'Rajdhani', sans-serif", outline: "none" };

    return (
      <div style={{ position: "fixed", inset: 0, overflow: "auto", background: BG }}>
        {/* The poster belongs to the window, not to the page. Riding inside the scroll
            content made its box grow the moment the content overflowed, so every resize
            re-scaled and re-cropped the artwork — the picture got sliced through the
            middle while the form fell off the bottom. A fixed layer can only ever show
            more or less of the same poster, at whatever shape the window is. */}
        <div style={{ position: "fixed", inset: 0, overflow: "hidden" }}>
          <ArtBackdrop />
        </div>
        {/* The language switch comes before anything else, because this is the first
            screen a customer meets and the one an unreadable app stops him at. */}
        <div style={{ position: "fixed", top: 16, right: 22, zIndex: 60 }}>
          <LanguageMenu />
        </div>
        {/* One column down the middle of the window. `margin: auto` centres it while it
            fits and keeps its top reachable once the window is shorter than the form;
            centring with the flex axis instead would push the form out of the scroll
            area, which is how it went missing on a low window. The top padding clears
            the fixed language switch — this is the first screen, it cannot be
            half-covered. */}
        <div style={{ position: "relative", minHeight: "100%", display: "flex", padding: "64px 24px 28px" }}>
          <div style={{ margin: "auto", width: "100%", maxWidth: 440, display: "flex", flexDirection: "column", alignItems: "center" }}>
            <Logo size={54} style={{ justifyContent: "center" }} />
            <h1 style={{
              fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 20, letterSpacing: "0.16em",
              textTransform: "uppercase", color: "hsl(190 80% 96%)", margin: "14px 0 0", textAlign: "center",
            }}>
              {t(authMode === "signup" ? "Create your account" : "Welcome back")}
            </h1>
            <p style={{ fontSize: 12.5, color: "hsl(222 25% 58%)", fontFamily: "'Rajdhani',sans-serif", margin: "8px 0 0", lineHeight: 1.5, textAlign: "center" }}>
              {t(authMode === "signup"
                ? "Nothing to buy up front. Use the email you can actually receive mail on — your administrator tops up the minutes you call with."
                : "Sign in with the account you created — your minutes, devices and requests are waiting.")}
            </p>
            <div style={{ width: "100%", marginTop: 16 }}>
              <Card>
                <p style={{ margin: 0, fontSize: 15.5, fontWeight: 700, lineHeight: 1.4, fontFamily: "'Rajdhani', sans-serif", color: "hsl(190 85% 95%)" }}>
                  {t("Your first account on a computer gets 1 minute of free video streaming to test the software.")}
                </p>
                <p style={{ margin: "7px 0 0", fontSize: 13, lineHeight: 1.45, fontFamily: "'Rajdhani', sans-serif", color: "hsl(187 55% 80%)" }}>
                  {t("That free minute shows a watermark on the AI video. Get minutes in your account — by buying them or by having them credited — and the watermark is gone.")}
                </p>
              </Card>
            </div>

            <div style={{ width: "100%", marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
              <Pill active={authMode === "signin"} label="Sign in" onClick={() => setAuthMode("signin")} />
              <Pill active={authMode === "signup"} label="Create account" onClick={() => setAuthMode("signup")} />
            </div>

            <Card pad={24} style={{ width: "100%", marginTop: 14 }}>
              <form onSubmit={handleAuth} style={{ display: "flex", flexDirection: "column", gap: 13 }}>
                {authMode === "signup" && (
                  <div>
                    <label style={labelSt}>{t("Display name")}</label>
                    <input value={name} onChange={e => setName(e.target.value)} placeholder={t("Optional")} style={ghost} />
                  </div>
                )}
                <div>
                  <label style={labelSt}>{t("Email")}</label>
                  <input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" style={ghost} />
                </div>
                <div>
                  <label style={labelSt}>{t("Password")}</label>
                  <input type="password" required minLength={6} autoComplete={authMode === "signup" ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} placeholder={t("At least 6 characters")} style={ghost} />
                </div>
                {/* No onClick here: this button is the form's own submit control, so a
                    click and the Enter key both run handleAuth exactly once. */}
                <PrimaryButton onClick={() => undefined} disabled={busy} style={{ width: "100%", marginTop: 2 }}>
                  {busy ? <Loader2 style={{ width: 15, height: 15, animation: "spin 1s linear infinite" }} /> : authMode === "signup" ? <UserPlus style={{ width: 15, height: 15 }} /> : <LogIn style={{ width: 15, height: 15 }} />}
                  {busy ? t("Please wait…") : authMode === "signup" ? t("Create account") : t("Sign in")}
                </PrimaryButton>
              </form>

              {(contact?.whatsapp || contact?.telegram) && (
                <div style={{ padding: "11px 13px", borderRadius: 11, background: "hsl(222 55% 5% / 0.7)", border: "1px solid hsl(222 40% 14%)", marginTop: 14 }}>
                  <ContactLine contact={contact} note={t("Trouble getting in, or want minutes before you pay? Message your administrator:")} />
                </div>
              )}
              <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap", marginTop: 14 }}>
                {["Video + Audio Call", "Video Call Only"].map(mode => (
                  <span key={mode} style={{
                    padding: "5px 10px", borderRadius: 999, fontSize: 9.5, fontWeight: 700,
                    letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "'Orbitron', monospace",
                    color: "hsl(187 100% 72%)", background: "hsl(187 100% 52% / 0.09)",
                    border: "1px solid hsl(187 100% 52% / 0.26)",
                  }}>{t(mode)}</span>
                ))}
              </div>
              <p style={{ fontSize: 11.5, color: "hsl(222 30% 62%)", fontFamily: "'Rajdhani', sans-serif", textAlign: "center", margin: "10px 0 0", lineHeight: 1.5 }}>
                {t("Real people · Real voices · AI powered — go live with your camera and mic, or feed an AI voice straight into OBS.")}
              </p>
            </Card>
          </div>
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  // ── Signed-in: balances, top-ups, requests, devices, password ────────────────
  return (
    <AppLayout>
      <Stage>
      <div style={{ maxWidth: 760, margin: "0 auto", paddingBottom: 40 }}>
        <PageHead
          name="Your account"
          card={
            <Card pad={14} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <p style={{ margin: 0, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, color: "hsl(222 25% 62%)", fontFamily: "'Rajdhani', sans-serif" }}>
                {account.email}
              </p>
              <button onClick={handleSignOut}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, flexShrink: 0, background: "hsl(222 40% 11%)", border: "1px solid hsl(222 40% 18%)", cursor: "pointer", color: "hsl(222 25% 70%)", fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani', sans-serif" }}>
                <LogOut style={{ width: 14, height: 14 }} /> {t("Sign out")}
              </button>
            </Card>
          }
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Minutes live on their own dashboard */}
          <Card pad={0}>
            <button onClick={() => setLocation("/minutes")}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, width: "100%", cursor: "pointer", textAlign: "left", background: "transparent", border: "none", padding: 18 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Hourglass style={{ width: 16, height: 16, color: D2 }} />
                <span>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif" }}>{t("Your minutes")}</span>
                  <span style={{ display: "block", fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 2 }}>
                    {t("Balances per bucket, your live countdown, and asking for more")}
                  </span>
                </span>
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: D2, fontFamily: "'Orbitron',monospace" }}>{t("OPEN →")}</span>
            </button>
          </Card>

          {/* What minutes cost and who to pay */}
          <Card pad={0}>
            <button onClick={() => setLocation("/minutes")}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, width: "100%", cursor: "pointer", textAlign: "left", background: "transparent", border: "none", padding: 18 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <CreditCard style={{ width: 16, height: 16, color: D2 }} />
                <span>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif" }}>{t("Buy minutes")}</span>
                  <span style={{ display: "block", fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 2 }}>
                    {t("Every package on sale, what each one includes and how to reach your administrator")}
                  </span>
                </span>
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: D2, fontFamily: "'Orbitron',monospace" }}>{t("OPEN →")}</span>
            </button>
          </Card>

          {/* Devices */}
          <Card>
            <CardTitle>{t("Your devices")}</CardTitle>
            {devices.length === 0 ? (
              <p style={{ fontSize: 13, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani', sans-serif" }}>{t("No devices recorded yet.")}</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {devices.map(d => (
                  <div key={String(d.device_id)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 12px", background: "hsl(222 40% 8%)", borderRadius: 8, border: "1px solid hsl(222 40% 12%)" }}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: 12, color: "hsl(190 80% 92%)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(d.label || d.device_id)}</p>
                      <p style={{ fontSize: 10, color: "hsl(222 25% 40%)", fontFamily: "'Rajdhani', sans-serif" }}>{t("last seen")} {fmtDate(d.last_seen as string)}</p>
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "'Orbitron', monospace", color: "hsl(222 25% 42%)" }}>{t("in use")}</span>
                  </div>
                ))}
              </div>
            )}
            <p style={{ fontSize: 11.5, color: "hsl(222 25% 48%)", fontFamily: "'Rajdhani', sans-serif", margin: "12px 0 0", lineHeight: 1.5 }}>
              {t("A device joins this list the first time a call starts on it, and stays tied to your account. If you are told you have too many devices, your administrator frees one for you.")}
            </p>
          </Card>

          {/* Change password */}
          <Card>
            <CardTitle>{t("Change password")}</CardTitle>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label style={labelSt}>{t("New password")}</label>
                <input type="password" minLength={6} value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder={t("At least 6 characters")} style={inputSt} />
              </div>
              <PrimaryButton onClick={handleChangePassword} disabled={changingPw || !newPassword}>
                <KeyRound style={{ width: 14, height: 14 }} /> {changingPw ? t("Saving…") : t("Update")}
              </PrimaryButton>
            </div>
          </Card>
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </Stage>
    </AppLayout>
  );
}
