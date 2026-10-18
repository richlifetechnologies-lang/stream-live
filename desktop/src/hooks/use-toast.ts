import { useState, useCallback } from "react";

type ToastVariant = "default" | "destructive";

interface Toast {
  id: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
  /**
   * Show the administrator's WhatsApp / Telegram under this message. Only a refusal the
   * customer cannot fix themselves earns it — the rest stay quiet, because on the pages
   * that already carry his numbers a second copy is noise.
   */
  withContact?: boolean;
}

let listeners: Array<(toasts: Toast[]) => void> = [];
let toasts: Toast[] = [];

function dispatch(toast: Toast) {
  toasts = [...toasts, toast];
  listeners.forEach((l) => l(toasts));
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== toast.id);
    listeners.forEach((l) => l(toasts));
  }, toast.duration ?? (toast.withContact ? 12_000 : 4_000));
}

export function useToast() {
  const [, setT] = useState(0);

  const subscribe = useCallback((fn: (t: Toast[]) => void) => {
    listeners.push(fn);
    return () => { listeners = listeners.filter((l) => l !== fn); };
  }, []);

  const toast = useCallback(
    (opts: Omit<Toast, "id">) => {
      dispatch({ ...opts, id: Math.random().toString(36).slice(2) });
      setT((n) => n + 1);
    },
    []
  );

  return { toast, toasts, subscribe };
}
