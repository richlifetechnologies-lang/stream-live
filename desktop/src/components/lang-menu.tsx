import { useEffect, useRef, useState } from "react";
import { LANGS, setLang, t, useLang, type LangCode } from "../lib/i18n";

const C = "hsl(187 100% 52%)";

/**
 * The language switch. It lives in the top-right corner of the window because that is
 * where a person who cannot read a single word on the screen still knows to look, and
 * because a setting that has to be found in Settings is useless to exactly the people
 * this exists for.
 *
 * Every language is written in its own script, with the English name beside it, so
 * "Español" can be picked without reading English.
 */
export function LanguageMenu({ drop = "right" }: { drop?: "right" | "left" }) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const pick = (code: LangCode) => { setLang(code); setOpen(false); };
  const cur = LANGS.find(l => l.code === lang) ?? LANGS[0];

  return (
    <div ref={box} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 7, padding: "7px 12px", borderRadius: 999,
          background: open ? "hsl(187 100% 52% / 0.14)" : "hsl(222 40% 11%)",
          border: `1px solid ${open ? C : "hsl(222 40% 18%)"}`,
          color: open ? C : "hsl(222 25% 65%)", cursor: "pointer",
          fontSize: 12, fontWeight: 700, fontFamily: "'Rajdhani', sans-serif", letterSpacing: "0.03em",
          whiteSpace: "nowrap",
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C} strokeWidth="1.7" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c3 4 3 14 0 18M12 3c-3 4-3 14 0 18" />
        </svg>
        {cur.native}
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          {open ? <path d="M2 6l3-3 3 3" /> : <path d="M2 4l3 3 3-3" />}
        </svg>
      </button>

      {open && (
        <div role="listbox" style={{
          position: "absolute", top: "calc(100% + 8px)",
          left: drop === "left" ? 0 : undefined, right: drop === "right" ? 0 : undefined,
          minWidth: 210,
          background: "hsl(222 50% 6%)", border: "1px solid hsl(222 40% 16%)", borderRadius: 12,
          padding: 6, boxShadow: "0 18px 44px hsl(226 80% 2% / 0.7)", zIndex: 80,
        }}>
          <p style={{
            fontSize: 9.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase",
            color: "hsl(222 25% 45%)", fontFamily: "'Orbitron', monospace", padding: "8px 10px 7px",
          }}>
            {t("Choose your language")}
          </p>
          {LANGS.map(l => {
            const on = l.code === lang;
            return (
              <button key={l.code} role="option" aria-selected={on} onClick={() => pick(l.code)} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14,
                width: "100%", padding: "10px 11px", borderRadius: 9, cursor: "pointer",
                background: on ? "hsl(187 100% 52% / 0.12)" : "transparent",
                border: `1px solid ${on ? "hsl(187 100% 52% / 0.35)" : "transparent"}`,
                textAlign: "left",
              }}>
                <span style={{
                  fontSize: 14, fontWeight: 700, fontFamily: "'Rajdhani', sans-serif",
                  color: on ? C : "hsl(190 80% 92%)",
                }}>
                  {l.native}
                </span>
                <span style={{ fontSize: 10.5, fontWeight: 600, fontFamily: "'Rajdhani', sans-serif", color: "hsl(222 25% 45%)" }}>
                  {l.english}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
