import { useState } from "react";
import { Bitcoin, Copy, Check, MessageCircle, Send, Smartphone } from "lucide-react";
import type { AdminContact, AdminPayment } from "@stream-live/client";

const C = "hsl(187 100% 52%)";

/** True when the administrator has filled in anything worth showing. */
export function hasContact(c: AdminContact | null): boolean {
  return !!c && !!(c.message || c.whatsapp || c.telegram);
}

export function hasPayment(p: AdminPayment | null): boolean {
  return !!p && !!(p.momo || p.btc);
}

function waLink(v: string): string {
  return `https://wa.me/${v.replace(/\D/g, "")}`;
}

function tgLink(v: string): string {
  const handle = v.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
  return handle.startsWith("+") ? `https://t.me/${handle.slice(1)}` : `https://t.me/${handle}`;
}

function Row({ icon: Icon, label, value, href }: {
  icon: React.ElementType; label: string; value: string; href?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => { /* clipboard is unavailable outside a secure context */ });
  };
  const text = href
    ? <a href={href} target="_blank" rel="noreferrer" style={{ fontSize: 13.5, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif", textDecoration: "none", overflowWrap: "anywhere" }}>{value}</a>
    : <p style={{ fontSize: 13.5, color: "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif", margin: 0, overflowWrap: "anywhere" }}>{value}</p>;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: "hsl(222 40% 8%)", border: "1px solid hsl(222 40% 12%)", borderRadius: 9 }}>
      <Icon style={{ width: 15, height: 15, color: C, flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <p style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", color: "hsl(222 25% 45%)", margin: 0 }}>{label}</p>
        {text}
      </div>
      <button onClick={copy} title="Copy"
        style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 9px", borderRadius: 7, background: copied ? "hsl(143 72% 40% / 0.18)" : "hsl(222 40% 11%)", border: `1px solid ${copied ? "hsl(143 72% 55% / 0.5)" : "hsl(222 40% 18%)"}`, cursor: "pointer", color: copied ? "hsl(143 72% 60%)" : "hsl(222 25% 55%)", fontSize: 10.5, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", flexShrink: 0 }}>
        {copied ? <Check style={{ width: 11, height: 11 }} /> : <Copy style={{ width: 11, height: 11 }} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 18, marginBottom: 14 }}>
      <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron', monospace", marginBottom: 12 }}>{title}</p>
      {children}
    </div>
  );
}

/**
 * The two methods the administrator accepts. Copy matters here — a BTC address
 * typed by hand never arrives.
 */
export function PayCard({ pay, title = "Pay the administrator" }: { pay: AdminPayment | null; title?: string }) {
  if (!hasPayment(pay)) return null;
  return (
    <Shell title={title}>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {pay!.momo && <Row icon={Smartphone} label="MoMo — mobile money" value={pay!.momo} />}
        {pay!.btc && <Row icon={Bitcoin} label="Bitcoin address" value={pay!.btc} />}
      </div>
    </Shell>
  );
}

/** The administrator's contact centres — send the payment reference here. */
export function ContactCard({ contact, title = "Contact the administrator" }: { contact: AdminContact | null; title?: string }) {
  if (!hasContact(contact)) return null;
  return (
    <Shell title={title}>
      {contact!.message && (
        <p style={{ fontSize: 13, color: "hsl(222 25% 68%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.6, whiteSpace: "pre-line", margin: "0 0 12px", padding: "10px 13px", background: "hsl(187 100% 52% / 0.07)", border: "1px solid hsl(187 100% 52% / 0.18)", borderRadius: 9 }}>
          {contact!.message}
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {contact!.whatsapp && <Row icon={MessageCircle} label="WhatsApp" value={contact!.whatsapp} href={waLink(contact!.whatsapp)} />}
        {contact!.telegram && <Row icon={Send} label="Telegram" value={contact!.telegram} href={tgLink(contact!.telegram)} />}
      </div>
    </Shell>
  );
}
