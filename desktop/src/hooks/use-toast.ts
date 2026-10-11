import { useState, useCallback } from "react";

type ToastVariant = "default" | "destructive";

interface Toast {
  id: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
}

let listeners: Array<(toasts: Toast[]) => void> = [];
let toasts: Toast[] = [];

function dispatch(toast: Toast) {
  toasts = [...toasts, toast];
  listeners.forEach((l) => l(toasts));
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== toast.id);
    listeners.forEach((l) => l(toasts));
  }, toast.duration ?? 4000);
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
