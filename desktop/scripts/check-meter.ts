import { countdown, drainOf, stopDeadlineAt, type LiveLease } from "../src/lib/minutes";

const fail: string[] = [];
const eq = (label: string, got: number | string | boolean | null, want: number | string | boolean | null) => {
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
  fundedUntilAt: null,
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

// ─── The second the app stops the call ─────────────────────────────────────────
// Before the gateway ever answers with a bound, the countdown is all there is, so a call
// with 100.5 minutes left is timed at 6030 seconds from it.
eq("no bound yet: the meter is the deadline", (stopDeadlineAt(lease, 1, at, 10_000) - at) / 1000, 6030);
// A video call still waiting for its picture spends nothing, so nothing is cut short.
eq("no picture yet: not cut short",
  (stopDeadlineAt({ ...lease, mediaAt: null, fundedUntilAt: null }, 1, at, 10_000) - at) / 1000, 101 * 60);

// Yesterday's free-trial call, replayed second by second. The account was granted 1.000
// minute, the whole minute was pre-paid when the call opened, the picture landed at t-45s
// and the first heartbeat reached the wallet at t0. The gateway charged 0.750 of the
// minute, gave the 0.250 nobody had used back, and bought the next window with it: so the
// answer carries 0.750 charged so far, and a window of 0.250 credit minutes at the trial's
// one-for-one rate = 15.0 seconds of airtime.
const t0 = at;
const afterBeat: LiveLease = {
  sessionId: "t", modality: "video", balance: 0, unlimited: false,
  billedMinutes: 0.75, fundedUntilAt: t0 + 15_000, startBalance: 1,
  startedAt: t0 - 45_000, observedAt: t0, mediaAt: t0 - 45_000, leaseExpiresAt: null, lowBalance: true,
};
eq("replay: the meter is empty exactly at the bound", drainOf(afterBeat, 1, t0 + 15_000).remaining, 0);
eq("replay: the call is cut at the sixty-second second",
  (stopDeadlineAt(afterBeat, 1, t0, 10_000) - t0) / 1000, 15);
// What the same call did with an answer that said nothing about the charge: the meter still
// read a full minute, so the guard re-armed for sixty more seconds on every heartbeat - and
// a second heartbeat re-armed it again, which is how a one minute trial reached 1:31.
const blind: LiveLease = { ...afterBeat, billedMinutes: 0, fundedUntilAt: null };
eq("replay: the old silent answer kept it on air",
  (stopDeadlineAt(blind, 1, t0, 10_000) - t0) / 1000, 60);
// A paid bucket with minutes to spare is re-armed long before its window lapses: a 2.000
// minute window at 1x is 120 seconds, and the heartbeat comes every 45.
eq("paid call: the bound is the server's, not the wallet's",
  (stopDeadlineAt({ ...lease, fundedUntilAt: at + 120_000 }, 1, at, 10_000) - at) / 1000, 120);
// A heartbeat that lands after its window had already run out buys the new window from the
// instant the old one ended, so the seconds named are fewer than the window - and the app
// must not hand that late stretch back a second time.
eq("late heartbeat: counted from when the window really started",
  (stopDeadlineAt({ ...afterBeat, fundedUntilAt: t0 + 50_000 }, 1, t0, 10_000) - t0) / 1000, 50);
// A bound already in the past stops at once rather than arming a timer for a negative delay.
eq("window already spent: stops now", stopDeadlineAt({ ...afterBeat, fundedUntilAt: t0 - 5_000 }, 1, t0, 10_000) < t0, true);
// And a call opened on the last sliver of change is not dropped like a failure: it gets its
// first ten seconds from the frame even though the wallet is empty.
eq("last sliver: gets its opening seconds",
  (stopDeadlineAt({ ...afterBeat, billedMinutes: 0.99, fundedUntilAt: t0 + 600,
    startedAt: t0 - 2_000, mediaAt: t0 - 2_000 }, 1, t0, 10_000) - t0) / 1000, 8);

console.log(fail.length ? `FAILED: ${fail.join(", ")}` : "all meter maths pass");
