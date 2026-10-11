export interface LiveSession {
  startedAt: number;
  elapsedSecs: number;
  credits: number;
  usd: number;
  isActive: boolean;
}

export interface PastSession {
  id: string;
  startedAt: number;
  endedAt: number;
  durationSecs: number;
  credits: number;
  usd: number;
}

const HISTORY_KEY = "ss_session_history";
const MAX_HISTORY = 200;

type Listener = (session: LiveSession) => void;
const listeners = new Set<Listener>();

let live: LiveSession = { startedAt: 0, elapsedSecs: 0, credits: 0, usd: 0, isActive: false };

function notify() {
  listeners.forEach(fn => fn({ ...live }));
}

export function subscribeLiveSession(fn: Listener): () => void {
  listeners.add(fn);
  fn({ ...live });
  return () => listeners.delete(fn);
}

export function getLiveSession(): LiveSession {
  return { ...live };
}

export function sessionStart() {
  live = { startedAt: Date.now(), elapsedSecs: 0, credits: 0, usd: 0, isActive: true };
  notify();
}

export function sessionTick(elapsedSecs: number) {
  live = { ...live, elapsedSecs, credits: elapsedSecs * 2, usd: elapsedSecs * 0.02, isActive: true };
  notify();
}

export function sessionEnd() {
  if (!live.isActive) return;
  if (live.elapsedSecs > 0) {
    const past: PastSession = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      startedAt: live.startedAt,
      endedAt: Date.now(),
      durationSecs: live.elapsedSecs,
      credits: live.credits,
      usd: live.usd,
    };
    const history = getPastSessions();
    history.unshift(past);
    if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* ignore */ }
  }
  live = { startedAt: 0, elapsedSecs: 0, credits: 0, usd: 0, isActive: false };
  notify();
}

export function getPastSessions(): PastSession[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); }
  catch { return []; }
}

export function clearSessionHistory() {
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
}
