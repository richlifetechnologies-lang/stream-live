import { Link, useLocation } from "wouter";
import { Video, Settings, Zap } from "lucide-react";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", icon: Video, label: "Stream" },
    { href: "/usage", icon: Zap, label: "Usage" },
    { href: "/settings", icon: Settings, label: "Settings" },
  ];

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "hsl(222 47% 4%)" }}>
      {/* Sidebar */}
      <aside style={{
        width: 64,
        background: "hsl(222 50% 5%)",
        borderRight: "1px solid hsl(222 40% 9%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: 16,
        paddingBottom: 16,
        gap: 4,
        flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: "linear-gradient(135deg, hsl(187 100% 52%) 0%, hsl(200 100% 45%) 100%)",
          display: "flex", alignItems: "center", justifyContent: "center",
          marginBottom: 16,
        }}>
          <Video style={{ width: 18, height: 18, color: "hsl(222 47% 4%)" }} />
        </div>

        {navItems.map(({ href, icon: Icon, label }) => {
          const active = href === "/" ? location === "/" : location.startsWith(href);
          return (
            <Link key={href} href={href}>
              <a title={label} style={{
                width: 44, height: 44, borderRadius: 10,
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", transition: "all 0.2s",
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
                <Icon style={{ width: 18, height: 18 }} />
              </a>
            </Link>
          );
        })}
      </aside>

      {/* Main content */}
      <main style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
        {children}
      </main>
    </div>
  );
}
