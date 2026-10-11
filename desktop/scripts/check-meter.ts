import { countdown, drainOf, type LiveLease } from "../src/lib/minutes";

const fail: string[] = [];
const eq = (label: string, got: number | string | null, want: number | string | null) => {
  const ok = typeof got === "number" && typeof want === "number"
    ? Math.abs(got - want) < 1e-9
    : String(got) === String(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${got} want ${want}`);
  if (!ok) fail.push(label);
};

// 100.000 minutes at 1x, read 30 s ago → 29.5 credit minutes drained since.
const lease: LiveLease = {
  sessionId: "s", modality: "video_audio", balance: 100, unlimited: false, billedMinutes: 4,
  startBalance: 105, startedAt: Date.now() - 600_000, observedAt: Date.now() - 30_000,
  leaseExpiresAt: null, lowBalance: false,
};
const at = Date.now();
const d = drainOf(lease, 1, at);
eq("drain after 30s @1x", d.remaining, 100 - 0.5);
eq("used this call", d.used, 4 + 0.5);
eq("on air", Math.round(d.live), 10);

// A 1.5x bucket burns a real minute as 1.5 credit minutes.
const fast = drainOf({ ...lease, balance: 60 }, 1.5, at);
eq("drain after 30s @1.5x", fast.remaining, 60 - 0.75);

// Never below zero, whatever the drift.
eq("floors at zero", drainOf({ ...lease, balance: 0.1 }, 1, at).remaining, 0);

// Unlimited buckets report null, not a countdown.
eq("unlimited stays null", drainOf({ ...lease, unlimited: true, balance: null }, 1, at).remaining, null);

eq("7.25 min", countdown(7.25), "7:15");
eq("zero", countdown(0), "0:00");
eq("120.5 min", countdown(120.5), "120:30");
eq("unlimited", countdown(null), "∞");

// One second of a 1x bucket must move the display by exactly one second.
const a = countdown(drainOf(lease, 1, at).remaining);
const b = countdown(drainOf(lease, 1, at + 1000).remaining);
console.log(`tick ${a} -> ${b}`);
const secs = (m: string) => { const parts = m.split(":").map(Number); return parts[0] * 60 + parts[1]; };
eq("per-second tick", secs(a) - secs(b), 1);

console.log(fail.length ? `FAILED: ${fail.join(", ")}` : "all meter maths pass");
