import { useEffect, useState } from "react";
import { GATEWAY_CONFIGURED } from "../lib/gateway-config";

const WARN = "hsl(38 95% 55%)";
const ERR = "hsl(0 80% 62%)";

type StatusItem = { id: string; text: string; color: string };

// Short, plain, dismissible lines about why the updater could not do its job —
// the long detail belongs in updater.log in the app data folder, not on screen.
export default function StatusBanner() {
  const [messages, setMessages] = useState<StatusItem[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    window.electronAPI?.onUpdateStatus?.((info) => {
      // download-failed belongs to the update banner, which owns the retry button
      if (info.kind === "download-failed") return;
      if (info.kind === "ok" || !info.message) {
        setMessages((prev) => prev.filter((m) => m.id !== "updater"));
        return;
      }
      const text = `Stream Live couldn’t check for updates — ${info.message}`;
      setMessages((prev) => {
        const next: StatusItem = { id: "updater", text, color: ERR };
        return prev.some((m) => m.text === text) ? prev : [...prev.filter((m) => m.id !== "updater"), next];
      });
    });
  }, []);

  useEffect(() => {
    if (GATEWAY_CONFIGURED) return;
    setMessages((prev) => prev.some((m) => m.id === "gateway")
      ? prev
      : [{
          id: "gateway",
          color: WARN,
          text: "This Stream Live build was installed without its gateway settings, so sign-in cannot work. " +
                "Reinstall the current build from https://github.com/richlifetechnologies-lang/stream-live/releases",
        }, ...prev]);
  }, []);

  const visible = messages.filter((m) => !dismissed.has(m.id));
  if (!visible.length) return null;

  return (
    <div style={{
      position: "fixed", bottom: 16, left: 16, zIndex: 9998,
      display: "flex", flexDirection: "column", gap: 8, maxWidth: 460,
    }}>
      {visible.map((m) => (
        <div key={m.id} style={{
          display: "flex", alignItems: "flex-start", gap: 10,
          padding: "10px 12px", borderRadius: 10,
          background: "hsl(222 44% 8%)",
          border: `1px solid ${m.color}55`,
          boxShadow: `0 8px 28px ${m.color}22`,
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%", marginTop: 5, flexShrink: 0,
            background: m.color,
          }} />
          <p style={{
            flex: 1, margin: 0, fontSize: 12, lineHeight: 1.45,
            color: "hsl(222 25% 78%)", fontFamily: "'Rajdhani', sans-serif",
          }}>
            {m.text}
          </p>
          <button
            onClick={() => setDismissed((prev) => new Set(prev).add(m.id))}
            style={{
              padding: "4px 10px", borderRadius: 6, flexShrink: 0,
              background: "hsl(222 40% 12%)", border: "1px solid hsl(222 40% 20%)",
              color: "hsl(222 25% 60%)", fontSize: 11, fontWeight: 700,
              fontFamily: "'Rajdhani', sans-serif", cursor: "pointer",
            }}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
