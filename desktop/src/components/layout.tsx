import { Link, useLocation } from "wouter";
import { Video, Settings, History, Hourglass, User, CreditCard } from "lucide-react";
import { Logo } from "./brand";
import { ContactLine } from "./contact";
import { useAdminContact } from "../lib/gateway";

/**
 * Width of the nav rail. Anything that centres itself against the window rather
 * than against the page has to subtract it, so it is exported instead of repeated.
 */
export const RAIL_W = 190;

/** Pages that already carry the full contact card in their own body. */
const HAS_CARD = ["/minutes", "/plans"];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const contact = useAdminContact();

  const navItems = [
    { href: "/", icon: Video, label: "Stream" },
    { href: "/minutes", icon: Hourglass, label: "Minutes" },
    { href: "/plans", icon: CreditCard, label: "Plans & prices" },
    { href: "/account", icon: User, label: "Account" },
    { href: "/usage", icon: History, label: "History" },
    { href: "/settings", icon: Settings, label: "Settings" },
  ];

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "hsl(222 47% 4%)" }}>
      {/* Sidebar — every tab names itself: the symbols alone read as a puzzle. */}
      <aside style={{
        width: RAIL_W,
        background: "hsl(222 50% 5%)",
        borderRight: "1px solid hsl(222 40% 9%)",
        display: "flex",
        flexDirection: "column",
        paddingTop: 16,
        paddingBottom: 16,
        gap: 4,
        flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ display: "flex", justifyContent: "center", width: "100%", marginBottom: 16 }}>
          <Logo size={34} />
        </div>

        {navItems.map(({ href, icon: Icon, label }) => {
          const active = href === "/" ? location === "/" : location.startsWith(href);
          return (
            <div key={href} style={{ padding: "0 12px" }}>
              <Link href={href}>
                <a title={label} style={{
                  height: 40, borderRadius: 10,
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "0 12px", cursor: "pointer", transition: "all 0.2s",
                  background: active ? "hsl(187 100% 52% / 0.15)" : "transparent",
                  border: active ? "1px solid hsl(187 100% 52% / 0.35)" : "1px solid transparent",
                  color: active ? "hsl(187 100% 52%)" : "hsl(222 25% 50%)",
                  textDecoration: "none",
                }}
                onMouseEnter={e => {
                  if (!active) {
                    (e.currentTarget as HTMLElement).style.background = "hsl(222 40% 10%)";
                    (e.currentTarget as HTMLElement).style.color = "hsl(190 80% 90%)";
                  }
                }}
                onMouseLeave={e => {
                  if (!active) {
                    (e.currentTarget as HTMLElement).style.background = "transparent";
                    (e.currentTarget as HTMLElement).style.color = "hsl(222 25% 50%)";
                  }
                }}
                >
                  <Icon style={{ width: 18, height: 18, flexShrink: 0 }} />
                  <span style={{
                    fontSize: 13, fontWeight: active ? 700 : 600, lineHeight: 1,
                    fontFamily: "'Rajdhani', sans-serif", letterSpacing: "0.02em",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {label}
                  </span>
                </a>
              </Link>
            </div>
          );
        })}

        {/* The administrator, always one glance away — a card on another page is
            something a stuck customer has to go and find. The two pages that already
            carry the full card are left alone, so the numbers never show twice. */}
        {contact && !HAS_CARD.some(p => location.startsWith(p)) && (
          <div style={{ marginTop: "auto", padding: "14px 12px 0", borderTop: "1px solid hsl(222 40% 9%)" }}>
            <ContactLine contact={contact} stack note="Stuck? Message your administrator:" />
          </div>
        )}
      </aside>

      {/* Main content */}
      <main style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
        {children}
      </main>
    </div>
  );
}
