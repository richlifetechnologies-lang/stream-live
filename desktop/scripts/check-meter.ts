import { countdown, drainOf, type LiveLease } from "../src/lib/minutes";

const fail: string[] = [];
const eq = (label: string, got: number | string | null, want: number | string | null) => {
  const ok = typeof got === "number" && typeof want === "number"
    ? Math.abs(got - want) < 1e-9
    : String(got) === String(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${got} want ${want}`);
  if (!ok) fail.push(label);
};

// A video call that found its picture 30 seconds ago. The wallet held 105.000 when
// the call opened and the gateway's last read said this call had already cost 4.000,
// so 30 seconds at 1x is 0.5 more on top of that.
const at = Date.now();
const lease: LiveLease = {
  sessionId: "s", modality: "video_audio", balance: 100, unlimited: false, billedMinutes: 4,
  startBalance: 105, startedAt: at - 600_000, observedAt: at - 30_000, mediaAt: at - 30_000,
  leaseExpiresAt: null, lowBalance: false,
};
const d = drainOf(lease, 1, at);
eq("drain after 30s @1x", d.remaining, 105 - 4.5);
eq("used this call", d.used, 4.5);
eq("on air counts from the picture", d.live, 0.5);
eq("so it is not waiting", d.waiting, false);

// A video call with no picture yet spends nothing and shows nothing spent, however
// long it has been connected - this is what the server's no-picture bound measures.
const dark = drainOf({ ...lease, mediaAt: null }, 1, at);
eq("no picture: used stays at the pre-debit", dark.used, 4);
eq("no picture: countdown has not moved", dark.remaining, 101);
eq("no picture: it is waiting", dark.waiting, true);
// An audio call has no picture to wait for, so it bills from the dial-tone.
const voice = drainOf({ ...lease, modality: "audio", mediaAt: null }, 1, at);
eq("audio is never waiting", voice.waiting, false);
eq("audio is on air from the call start", voice.live, 10);

// A 1.5x bucket burns a real minute as 1.5 credit minutes.
const fast = drainOf({ ...lease, startBalance: 60, billedMinutes: 0 }, 1.5, at);
eq("drain after 30s @1.5x", fast.remaining, 60 - 0.75);

// Never below zero, whatever the drift.
eq("floors at zero", drainOf({ ...lease, startBalance: 0.1, billedMinutes: 0 }, 1, at).remaining, 0);

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
