import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { AppLayout } from "../components/layout";
import { ArtBackdrop, Logo } from "../components/brand";
import { useToast } from "../hooks/use-toast";
import { gateway, useAccount, signIn, signUp, signOut } from "../lib/gateway";
import { GATEWAY_CONFIGURED } from "../lib/gateway-config";
import { toUserMessage } from "../lib/end-reason";
import { LogIn, LogOut, UserPlus, KeyRound, Loader2, Hourglass, CreditCard } from "lucide-react";

const C = "hsl(187 100% 52%)";
const BG = "hsl(222 47% 4%)";

// Refuses the addresses that cannot exist at all — nothing before the @, a space
// anywhere, a domain with no real ending. It cannot judge a correctly spelled address
// that belongs to nobody: only a link that actually arrives proves an address, which is
// why the account email is worth confirming. The gateway checks this same shape on the
// server, so an older build cannot get past it either.
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;

function emailProblem(value: string): string | null {
  const v = value.trim();
  if (!v) return "Enter your email address.";
  if (/\s/.test(v)) return "An email address cannot contain spaces.";
  if (!EMAIL_SHAPE.test(v)) return "That is not a valid email address. Check for a missing @, a missing dot, or a mistyped ending like “.con”.";
  return null;
}

function fmtDate(ts: string | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const card: React.CSSProperties = { background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 20, marginBottom: 14 };
const labelSt: React.CSSProperties = { display: "block", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron', monospace", marginBottom: 6, color: "hsl(222 25% 50%)" };
const inputSt: React.CSSProperties = { width: "100%", padding: "9px 12px", background: BG, border: "1px solid hsl(222 40% 14%)", borderRadius: 8, color: "hsl(190 80% 96%)", fontSize: 13, fontFamily: "'Rajdhani', sans-serif", outline: "none" };

export default function AccountPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const account = useAccount();

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
      toast({ title: "Gateway not configured", description: "This build was packaged without VITE_SUPABASE_ANON_KEY, so it cannot reach your account.", variant: "destructive" });
      return;
    }
    const badEmail = emailProblem(email);
    if (badEmail) {
      toast({ title: "Check the email address", description: badEmail, variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      if (authMode === "signup") {
        const session = await signUp(email.trim(), password, name.trim() || undefined);
        if (!session) {
          toast({ title: "Account created", description: "Your account works immediately — sign in to continue." });
          setAuthMode("signin");
        } else {
          toast({ title: "Welcome to Stream Live" });
        }
      } else {
        await signIn(email.trim(), password);
        toast({ title: "Signed in" });
      }
    } catch (err) {
      toast({ title: authMode === "signup" ? "Could not create account" : "Sign-in failed", description: toUserMessage(err, authMode === "signup" ? "We couldn't create the account. Try again." : "Check your email and password, then try again."), variant: "destructive" });
    } finally { setBusy(false); }
  };

  const handleChangePassword = async () => {
    if (changingPw) return;
    if (newPassword.length < 6) { toast({ title: "Use at least 6 characters.", variant: "destructive" }); return; }
    setChangingPw(true);
    try {
      const { error } = await gateway.raw.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setNewPassword("");
      toast({ title: "Password updated" });
    } catch (err) {
      toast({ title: "Could not update password", description: toUserMessage(err, "We couldn't update your password. Try again."), variant: "destructive" });
    } finally { setChangingPw(false); }
  };

  const handleSignOut = async () => {
    await signOut();
    setLocation("/account");
  };

  // ── Signed-out: full-screen artwork + auth form ──────────────────────────────
  if (!account.signedIn) {
    const segment = (mode: "signin" | "signup") => ({
      flex: 1, padding: "9px 10px", border: "none", cursor: "pointer", borderRadius: 9,
      background: authMode === mode ? C : "transparent",
      color: authMode === mode ? BG : "hsl(222 25% 62%)",
      fontSize: 13, fontWeight: 700, fontFamily: "'Rajdhani', sans-serif",
      transition: "all 0.18s",
    });
    const ghost: React.CSSProperties = { width: "100%", padding: "10px 13px", background: "hsl(226 60% 4% / 0.72)", border: "1px solid hsl(187 100% 52% / 0.18)", borderRadius: 9, color: "hsl(190 80% 96%)", fontSize: 14, fontFamily: "'Rajdhani', sans-serif", outline: "none" };

    return (
      <div style={{ position: "fixed", inset: 0, overflow: "auto", background: BG }}>
        <ArtBackdrop />
        <div style={{
          position: "relative", minHeight: "100%", display: "flex", alignItems: "center",
          justifyContent: "center", padding: "36px 24px",
        }}>
          <form onSubmit={handleAuth} style={{
            width: 392, maxWidth: "100%", display: "flex", flexDirection: "column", gap: 13,
            padding: 28, borderRadius: 20,
            background: "hsl(228 62% 4% / 0.88)", backdropFilter: "blur(18px) saturate(1.15)",
            border: "1px solid hsl(187 100% 52% / 0.22)",
            boxShadow: "0 26px 70px hsl(226 80% 2% / 0.6), 0 0 40px hsl(187 100% 52% / 0.1)",
          }}>
            <div style={{ textAlign: "center", marginBottom: 2 }}>
              <Logo size={54} style={{ justifyContent: "center", marginBottom: 10 }} />
              <h1 style={{ fontFamily: "'Orbitron', monospace", fontWeight: 700, fontSize: 21, color: "hsl(190 80% 96%)", marginBottom: 6 }}>
                {authMode === "signup" ? "Create your account" : "Welcome back"}
              </h1>
              <p style={{ color: "hsl(222 25% 58%)", fontSize: 12.5, lineHeight: 1.5, fontFamily: "'Rajdhani', sans-serif", margin: 0 }}>
                {authMode === "signup"
                  ? "Nothing to buy up front. Use the email you can actually receive mail on — your administrator tops up the minutes you call with."
                  : "Sign in with the account you created — your minutes, devices and requests are waiting."}
              </p>
              <div style={{ marginTop: 12, padding: "12px 14px", borderRadius: 12, background: "hsl(187 100% 52% / 0.08)", border: "1px solid hsl(187 100% 52% / 0.3)" }}>
                <p style={{ margin: 0, fontSize: 15.5, fontWeight: 700, lineHeight: 1.4, fontFamily: "'Rajdhani', sans-serif", color: "hsl(190 85% 95%)" }}>
                  Your first account on a computer gets 1 minute of free video streaming to test the software.
                </p>
                <p style={{ margin: "7px 0 0", fontSize: 13, lineHeight: 1.45, fontFamily: "'Rajdhani', sans-serif", color: "hsl(187 55% 80%)" }}>
                  That free minute shows a watermark on the AI video. Get minutes in your account — by buying them or by having them credited — and the watermark is gone.
                </p>
              </div>
            </div>

            <div style={{ display: "flex", gap: 4, padding: 4, borderRadius: 12, background: "hsl(222 55% 5% / 0.8)", border: "1px solid hsl(222 40% 14%)" }}>
              <button type="button" style={segment("signin")} onClick={() => setAuthMode("signin")}>Sign in</button>
              <button type="button" style={segment("signup")} onClick={() => setAuthMode("signup")}>Create account</button>
            </div>

            {authMode === "signup" && (
              <div>
                <label style={labelSt}>Display name</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Optional" style={ghost} />
              </div>
            )}
            <div>
              <label style={labelSt}>Email</label>
              <input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" style={ghost} />
            </div>
            <div>
              <label style={labelSt}>Password</label>
              <input type="password" required minLength={6} autoComplete={authMode === "signup" ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 6 characters" style={ghost} />
            </div>
            <button type="submit" disabled={busy}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "12px 18px", borderRadius: 10, border: "none", background: busy ? "hsl(222 40% 11%)" : C, color: busy ? "hsl(222 25% 35%)" : BG, fontWeight: 700, fontSize: 14, fontFamily: "'Rajdhani', sans-serif", cursor: busy ? "not-allowed" : "pointer", boxShadow: busy ? "none" : "0 0 26px hsl(187 100% 52% / 0.32)", marginTop: 2 }}>
              {busy ? <Loader2 style={{ width: 15, height: 15, animation: "spin 1s linear infinite" }} /> : authMode === "signup" ? <UserPlus style={{ width: 15, height: 15 }} /> : <LogIn style={{ width: 15, height: 15 }} />}
              {busy ? "Please wait…" : authMode === "signup" ? "Create account" : "Sign in"}
            </button>
            <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap", marginTop: 4 }}>
              {["Video + Audio Call", "Audio Call Only", "Video Call Only"].map(t => (
                <span key={t} style={{
                  padding: "5px 10px", borderRadius: 999, fontSize: 9.5, fontWeight: 700,
                  letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "'Orbitron', monospace",
                  color: "hsl(187 100% 72%)", background: "hsl(187 100% 52% / 0.09)",
                  border: "1px solid hsl(187 100% 52% / 0.26)",
                }}>{t}</span>
              ))}
            </div>
            <p style={{ fontSize: 11.5, color: "hsl(222 30% 62%)", fontFamily: "'Rajdhani', sans-serif", textAlign: "center", margin: 0, lineHeight: 1.5 }}>
              Real people · Real voices · AI powered — go live with your camera and mic, or feed an AI voice straight into OBS.
            </p>
          </form>
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  // ── Signed-in: balances, top-ups, requests, devices, password ────────────────
  return (
    <AppLayout>
      <div style={{ padding: "28px 32px", maxWidth: 720, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontFamily: "'Orbitron', monospace", fontWeight: 700, fontSize: 20, color: "hsl(190 80% 96%)", marginBottom: 2 }}>Your account</h1>
            <p style={{ fontSize: 13, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani', sans-serif" }}>{account.email}</p>
          </div>
          <button onClick={handleSignOut}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, background: "hsl(222 40% 11%)", border: "1px solid hsl(222 40% 18%)", cursor: "pointer", color: "hsl(222 25% 70%)", fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani', sans-serif" }}>
            <LogOut style={{ width: 14, height: 14 }} /> Sign out
          </button>
        </div>

        {/* Minutes live on their own dashboard */}
        <button onClick={() => setLocation("/minutes")}
          style={{ ...card, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, width: "100%", cursor: "pointer", textAlign: "left" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Hourglass style={{ width: 16, height: 16, color: C }} />
            <span>
              <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif" }}>Your minutes</span>
              <span style={{ display: "block", fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 2 }}>
                Balances per bucket, your live countdown, and asking for more
              </span>
            </span>
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: C, fontFamily: "'Orbitron',monospace" }}>OPEN →</span>
        </button>

        {/* What minutes cost and who to pay */}
        <button onClick={() => setLocation("/plans")}
          style={{ ...card, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, width: "100%", cursor: "pointer", textAlign: "left" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <CreditCard style={{ width: 16, height: 16, color: C }} />
            <span>
              <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif" }}>Plans and prices</span>
              <span style={{ display: "block", fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 2 }}>
                Packages on sale, what each one includes and how to reach your administrator
              </span>
            </span>
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: C, fontFamily: "'Orbitron',monospace" }}>OPEN →</span>
        </button>

        {/* Devices */}
        <div style={card}>
          <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron', monospace", marginBottom: 14 }}>Your devices</p>
          {devices.length === 0 ? (
            <p style={{ fontSize: 13, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani', sans-serif" }}>No devices recorded yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {devices.map(d => (
                <div key={String(d.device_id)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 12px", background: "hsl(222 40% 8%)", borderRadius: 8, border: "1px solid hsl(222 40% 12%)" }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 12, color: "hsl(190 80% 92%)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(d.label || d.device_id)}</p>
                    <p style={{ fontSize: 10, color: "hsl(222 25% 40%)", fontFamily: "'Rajdhani', sans-serif" }}>last seen {fmtDate(d.last_seen as string)}</p>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "'Orbitron', monospace", color: "hsl(222 25% 42%)" }}>in use</span>
                </div>
              ))}
            </div>
          )}
          <p style={{ fontSize: 11.5, color: "hsl(222 25% 48%)", fontFamily: "'Rajdhani', sans-serif", margin: "12px 0 0", lineHeight: 1.5 }}>
            A device joins this list the first time a call starts on it, and stays tied to your account. If you are told you have too many devices, your administrator frees one for you.
          </p>
        </div>

        {/* Change password */}
        <div style={card}>
          <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron', monospace", marginBottom: 14 }}>Change password</p>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={labelSt}>New password</label>
              <input type="password" minLength={6} value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="At least 6 characters" style={inputSt} />
            </div>
            <button onClick={handleChangePassword} disabled={changingPw || !newPassword}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", borderRadius: 8, border: "none", background: changingPw || !newPassword ? "hsl(222 40% 11%)" : C, color: changingPw || !newPassword ? "hsl(222 25% 35%)" : BG, fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani', sans-serif", cursor: changingPw || !newPassword ? "not-allowed" : "pointer" }}>
              <KeyRound style={{ width: 14, height: 14 }} /> {changingPw ? "Saving…" : "Update"}
            </button>
          </div>
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </AppLayout>
  );
}
