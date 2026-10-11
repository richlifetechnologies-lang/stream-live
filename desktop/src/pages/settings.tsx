import { useState } from "react";
import { useLocation } from "wouter";
import { AppLayout } from "../components/layout";
import { Key, Trash2, Eye, EyeOff, Save, LogOut, CheckCircle2 } from "lucide-react";
import { getApiKey, setApiKey, getVoiceKey, setVoiceKey, clearCredentials } from "../lib/credentials";
import { useToast } from "../hooks/use-toast";

const C  = "hsl(187 100% 52%)";
const VC = "hsl(265 90% 65%)";
const BG = "hsl(222 47% 4%)";

export default function SettingsPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [newEngKey, setNewEngKey]     = useState("");
  const [newVoiceKey, setNewVoiceKey] = useState("");
  const [showEng, setShowEng]         = useState(false);
  const [showVoice, setShowVoice]     = useState(false);
  const [engSaved, setEngSaved]       = useState(false);
  const [voiceSaved, setVoiceSaved]   = useState(false);

  const currentEngKey   = getApiKey()   ?? "";
  const currentVoiceKey = getVoiceKey() ?? "";

  const mask = (k: string) => k ? k.slice(0, 6) + "••••••••" + k.slice(-4) : "Not set";

  const saveEng = () => {
    const k = newEngKey.trim();
    if (!k || k.length < 8) { toast({ title: "Key too short", variant: "destructive" }); return; }
    setApiKey(k); setNewEngKey(""); setEngSaved(true);
    setTimeout(() => setEngSaved(false), 2500);
    toast({ title: "Engine key saved" });
  };

  const saveVoice = () => {
    const k = newVoiceKey.trim();
    if (!k || k.length < 8) { toast({ title: "Key too short", variant: "destructive" }); return; }
    setVoiceKey(k); setNewVoiceKey(""); setVoiceSaved(true);
    setTimeout(() => setVoiceSaved(false), 2500);
    toast({ title: "Voice Studio key saved" });
  };

  const handleClear = () => {
    if (!confirm("Remove all keys from this device? You will need to re-enter them.")) return;
    clearCredentials(); setLocation("/");
  };

  const inputSt: React.CSSProperties = {
    width: "100%", padding: "10px 40px 10px 40px",
    background: BG, border: "1px solid hsl(222 40% 14%)",
    borderRadius: 8, color: "hsl(190 80% 96%)",
    fontSize: 14, fontFamily: "'Rajdhani', sans-serif", outline: "none",
  };
  const labelSt: React.CSSProperties = {
    display: "block", fontSize: 10, fontWeight: 700, textTransform: "uppercase",
    letterSpacing: "0.12em", fontFamily: "'Orbitron', monospace", marginBottom: 8,
    color: "hsl(222 25% 50%)",
  };
  const card: React.CSSProperties = {
    background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)",
    borderRadius: 14, padding: 20, marginBottom: 14,
  };

  const KeyRow = ({ label, masked, accent }: { label: string; masked: string; accent: string }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "hsl(222 40% 8%)", borderRadius: 8, border: "1px solid hsl(222 40% 12%)" }}>
      <Key style={{ width: 14, height: 14, color: accent, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 10, color: "hsl(222 25% 45%)", fontFamily: "'Orbitron', monospace", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 2 }}>{label}</p>
        <p style={{ fontSize: 13, color: "hsl(190 80% 90%)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{masked}</p>
      </div>
    </div>
  );

  const SaveBtn = ({ disabled, saved, onClick, accent, label }: { disabled: boolean; saved: boolean; onClick: () => void; accent: string; label: string }) => (
    <button onClick={onClick} disabled={disabled}
      style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 18px", borderRadius: 8, width: "fit-content", border: "none", fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani', sans-serif", cursor: disabled ? "not-allowed" : "pointer", transition: "all 0.2s",
        background: disabled ? "hsl(222 40% 11%)" : saved ? "hsl(143 72% 35%)" : accent,
        color: disabled ? "hsl(222 25% 35%)" : saved ? "#fff" : "hsl(222 47% 4%)" }}>
      {saved ? <CheckCircle2 style={{ width: 14, height: 14 }} /> : <Save style={{ width: 14, height: 14 }} />}
      {saved ? "Saved!" : label}
    </button>
  );

  return (
    <AppLayout>
      <div style={{ padding: 32, maxWidth: 640 }}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontFamily: "'Orbitron', monospace", fontWeight: 700, fontSize: 20, letterSpacing: "0.06em", color: "hsl(190 80% 96%)", marginBottom: 4 }}>
            Account Settings
          </h1>
          <p style={{ color: "hsl(222 25% 50%)", fontSize: 14, fontFamily: "'Rajdhani', sans-serif" }}>
            Manage your Stream Studio keys stored on this device
          </p>
        </div>

        {/* ── Video Engine Key ─────────────────────────────────────────────── */}
        <div style={card}>
          <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron', monospace", marginBottom: 14 }}>
            Video Engine Key
          </p>
          <KeyRow label="Current Video Engine Key" masked={mask(currentEngKey)} accent={C} />
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={labelSt}>Enter New Key</label>
              <div style={{ position: "relative" }}>
                <Key style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "hsl(222 25% 40%)" }} />
                <input type={showEng ? "text" : "password"} value={newEngKey} onChange={e => setNewEngKey(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") saveEng(); }}
                  placeholder="Enter your Video Engine Key" style={inputSt}
                  onFocus={e => { e.target.style.borderColor = "hsl(187 100% 52% / 0.5)"; }}
                  onBlur={e => { e.target.style.borderColor = "hsl(222 40% 14%)"; }} />
                <button type="button" onClick={() => setShowEng(v => !v)}
                  style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "hsl(222 25% 45%)", padding: 4 }}>
                  {showEng ? <EyeOff style={{ width: 13, height: 13 }} /> : <Eye style={{ width: 13, height: 13 }} />}
                </button>
              </div>
            </div>
            <SaveBtn disabled={!newEngKey.trim()} saved={engSaved} onClick={saveEng} accent={C} label="Save Video Engine Key" />
          </div>
        </div>

        {/* ── Voice Studio Key ─────────────────────────────────────────────── */}
        <div style={{ ...card, border: `1px solid ${currentVoiceKey ? "hsl(265 90% 65% / 0.25)" : "hsl(222 40% 11%)"}` }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: VC, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron', monospace", marginBottom: 14 }}>
            Voice Studio Key
          </p>
          <KeyRow label="Current Voice Studio Key" masked={mask(currentVoiceKey)} accent={VC} />
          <p style={{ fontSize: 11, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani', sans-serif", lineHeight: 1.5, marginTop: 10, marginBottom: 10 }}>
            Required to use Voice Cloning in the Audio tab. Upload your own voice samples and transform your voice in real-time.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={{ ...labelSt, color: "hsl(265 70% 60%)" }}>Enter New Key</label>
              <div style={{ position: "relative" }}>
                <Key style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "hsl(222 25% 40%)" }} />
                <input type={showVoice ? "text" : "password"} value={newVoiceKey} onChange={e => setNewVoiceKey(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") saveVoice(); }}
                  placeholder="Enter your Voice Studio Key" style={inputSt}
                  onFocus={e => { e.target.style.borderColor = "hsl(265 90% 65% / 0.5)"; }}
                  onBlur={e => { e.target.style.borderColor = "hsl(222 40% 14%)"; }} />
                <button type="button" onClick={() => setShowVoice(v => !v)}
                  style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "hsl(222 25% 45%)", padding: 4 }}>
                  {showVoice ? <EyeOff style={{ width: 13, height: 13 }} /> : <Eye style={{ width: 13, height: 13 }} />}
                </button>
              </div>
            </div>
            <SaveBtn disabled={!newVoiceKey.trim()} saved={voiceSaved} onClick={saveVoice} accent={VC} label="Save Voice Studio Key" />
          </div>
        </div>

        {/* ── Danger zone ──────────────────────────────────────────────────── */}
        <div style={{ background: "hsl(0 60% 7%)", border: "1px solid hsl(0 85% 40% / 0.25)", borderRadius: 14, padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Trash2 style={{ width: 15, height: 15, color: "hsl(0 85% 65%)" }} />
            <p style={{ fontWeight: 700, fontSize: 14, color: "hsl(0 85% 75%)", fontFamily: "'Rajdhani', sans-serif" }}>Danger Zone</p>
          </div>
          <p style={{ fontSize: 13, color: "hsl(0 50% 60%)", marginBottom: 14, fontFamily: "'Rajdhani', sans-serif", lineHeight: 1.5 }}>
            Remove all keys and saved voices from this device.
          </p>
          <button onClick={handleClear}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 8, background: "hsl(0 85% 40% / 0.2)", border: "1px solid hsl(0 85% 40% / 0.4)", cursor: "pointer", color: "hsl(0 85% 70%)", fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani', sans-serif" }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.35)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.2)"; }}>
            <LogOut style={{ width: 13, height: 13 }} /> Remove All Keys &amp; Log Out
          </button>
        </div>
      </div>
    </AppLayout>
  );
}
