import { useState, useEffect } from "react";
import { useToast } from "../hooks/use-toast";
import { X } from "lucide-react";

export default function Toaster() {
  const { subscribe } = useToast();
  const [toasts, setToasts] = useState<Array<{ id: string; title: string; description?: string; variant?: string }>>([]);

  useEffect(() => {
    return subscribe(setToasts);
  }, [subscribe]);

  if (!toasts.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-full">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg"
          style={{
            background: t.variant === "destructive" ? "hsl(0 60% 12%)" : "hsl(222 44% 8%)",
            border: `1px solid ${t.variant === "destructive" ? "hsl(0 85% 40% / 0.5)" : "hsl(187 100% 52% / 0.3)"}`,
            boxShadow: `0 8px 32px ${t.variant === "destructive" ? "hsl(0 85% 55% / 0.15)" : "hsl(187 100% 52% / 0.1)"}`,
          }}
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold" style={{ color: t.variant === "destructive" ? "hsl(0 85% 75%)" : "hsl(190 80% 96%)", fontFamily: "'Rajdhani',sans-serif" }}>
              {t.title}
            </p>
            {t.description && (
              <p className="text-xs mt-0.5" style={{ color: "hsl(222 25% 60%)", fontFamily: "'Rajdhani',sans-serif" }}>
                {t.description}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
