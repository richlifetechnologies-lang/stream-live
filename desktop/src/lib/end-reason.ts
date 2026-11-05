// One place that turns machine reasons and raw gateway/Postgres errors into a
// short sentence a normal person can read. Anything we cannot explain safely
// becomes a generic sentence and the original goes to console.warn — never to
// the screen.

import { t } from "./i18n";

const GENERIC_END = "Something went wrong, so the call stopped. You weren't charged for it — please try again.";

const REASON_COPY: Record<string, string> = {
  out_of_minutes: "This account has no minutes to call with. Ask your administrator for more from your minutes dashboard.",
  modality_disabled: "This kind of call isn't switched on for your account. Ask your administrator to enable it.",
  // The administrator's tick on the account, read by the customer in his own words.
  clone_closed: "Voice cloning is closed on your account, so this kind of call can't start. Your administrator can open it again from your account.",
  // A free minute buys an ordinary video call, not a cloned voice - the clone costs real
  // money every time it answers, so it only ever runs on minutes that were paid for.
  clone_needs_paid_minutes: "Voice cloning needs minutes you've paid for, not your free trial minutes. Top up your video minutes and this call opens up.",
  // A microphone that isn't there, isn't allowed, or stopped feeding the app. Said plainly
  // and before any call, because the one thing this used to cost was a whole billed call
  // where nobody could hear the customer.
  mic_not_ready: "Your microphone isn't reaching the app, so the call didn't start and nothing was used. Let the app use your microphone, then pick it in the bar at the bottom of the page and try again.",
  // Mid-call: the picture kept moving but the voice stopped arriving.
  clone_stopped: "The cloned voice stopped answering, so the call was closed rather than left running with no voice for the people watching. Anything not used is back in your minutes.",
  // Mid-call, and not the voice service's fault: the microphone itself stopped feeding the app,
  // which used to be reported as a dead clone. The customer can reach this one - it is on his
  // desk - so the sentence names the plug, not our service.
  mic_stalled: "Your microphone stopped feeding the app in the middle of the call, so there was nothing left to turn into your cloned voice. The call was closed rather than left running silent, and nothing beyond it is used. Check the microphone is still plugged in and still allowed, pick it again in the bar at the bottom of the page, then press Start.",
  no_subscription: "Your account doesn't have a plan yet. Ask your administrator to set one up.",
  status_canceled: "Your administrator cancelled this account.",
  status_past_due: "This account is on hold for payment. Ask your administrator to sort it out.",
  status_expired: "This account is no longer active. Ask your administrator to reactivate it.",
  device_limit_reached: "You've reached the number of devices allowed on this account. Your administrator can free one up for you.",
  device_revoked: "This device was removed by your administrator.",
  concurrent_limit: "You're already on a call. End it before starting another one.",
  lines_busy: "The video line you need is still being released from the last call, so this one didn't open. Nothing was used for it — give it a minute and try again.",
  not_entitled: "This account isn't allowed to make that kind of call. Ask your administrator.",
  maintenance: "The service is being updated. Try again in a little while.",
  update_required: "This version of Stream Live is out of date. Update to keep going.",
  upstream_key: "Our AI service didn't answer. Try again in a minute — you weren't charged.",
  // The engine took the call, never showed a picture, and the automatic retries didn't
  // either. It says which step failed and says the one thing the customer needs to know
  // before he presses Start again: that the failed attempts cost him nothing.
  engine_no_answer: "The video line accepted your call and then never produced a picture, so we ended it and gave your minutes back. Nothing was used. Try again in a minute — if it keeps happening, tell your administrator, who can see exactly what the video service answered.",

  lease_expired: "We lost track of your call and ended it, so you weren't over-charged. Try again.",
  // The gateway only bills from the moment a picture arrives, so a call that never reported
  // one is closed rather than renewed for ever. Nothing was ever owed on it.
  no_picture: "Your call never showed a picture, so we ended it and gave back everything it had set aside. Nothing was used. Try again — if it keeps happening, tell your administrator, who can see exactly what the video service answered.",
  // The app closes a call that is still blank forty seconds in, rather than leaving the
  // customer sitting there until he presses Stop. He is not charged a second of it, so the
  // only thing left to tell him is the wait - and the wait has to be true: it is the same
  // number the server holds this machine for, and the button counts it down in front of him
  // instead of dialing again on its own.
  picture_hold: "No picture arrived, so the app ended your call instead of letting it run. Nothing was used - your minutes are exactly where they were. This computer has to wait about two minutes for the video line to release before its next call, and the Start button is counting that time down. Press it again when it reaches zero; starting sooner only gets refused.",
  // The two blanks this machine can prove, read off its own camera counter and its own
  // connection. Each one names the side of the cable the customer can reach, because the
  // one thing worse than a blank screen is a blank screen and a sentence about our service.
  // Neither of them promises a countdown the app may not be showing: whether this machine is
  // held afterwards is the video line's decision, so the wait is described, not counted.
  camera_stalled: "Your camera stopped feeding pictures to the app, so there was nothing for the video service to turn into your AI picture, and the call was closed rather than left running blank. Nothing was used - your minutes are exactly where they were. Pick your camera again in the bar at the bottom of the page, or unplug it and plug it back in, then press Start again. If it holds for a couple of minutes first, that is the video line being released and it costs you nothing.",
  never_connected: "No connection came up between this computer and the video line, so nothing ever reached your screen. Nothing was used - your minutes are exactly where they were. This is nearly always something in the way on this machine: switch off a VPN, let the app through your firewall, or try a different network, then press Start again. If it holds for a couple of minutes first, that is the video line being released and it costs you nothing.",
  // The one blank that is not his: the video service answered the dial itself with a refusal,
  // so this machine's camera and network were never asked to do anything. It says whose problem
  // it is in as few words as possible, because the sentence it replaces told him to go and
  // turn off a VPN while the line on our side was the thing that was full.
  line_full: "Our video line was full when you asked for it, so this call never opened. Nothing was used - your minutes are exactly where they were. There is nothing here for you to fix: it is our line, not your computer. Wait a couple of minutes and press Start again; if the button holds you for a short count-down first, that is the line being released and it costs you nothing.",
  // The voice-only tab has no picture to fail: the only thing it can lack is the cloned voice.
  // The meter never started without it, so the one thing worth telling him is that he was not
  // charged and can press Start again straight away.
  no_voice: "No cloned voice came back from the service, so your call was ended instead of left running silent. Nothing was used - your minutes are exactly where they were. Press Start again whenever you are ready; if it keeps happening, tell your administrator, who can see what the voice service answered.",
  no_lease: "Your call was ended because its booking lapsed. Try starting again.",
  // The video software checks the call pass against the clock on the machine it runs on. A
  // computer set hours away from real time therefore reads a minutes-old pass as already
  // spent and never asks for the call - which looks exactly like a dead video line, and is
  // fixed somewhere the customer can reach.
  clock_skew: "Your computer's clock is running hours away from real time, and that is what stopped the call - the video line was never asked for it. Turn on automatic time in your computer's settings, then start again.",
  session_not_found: "We couldn't find your session any more, so the call stopped. Try again.",
  connection_lost: "Your internet connection dropped, so the call ended. Check your network and try again.",
  signed_out: "You were signed out. Please sign in again.",
};

/** Plain-English sentence for a gateway/session reason. Unknown reasons never leak to the UI. */
export function endReasonMessage(reason?: string | null, detail?: string): string {
  if (!reason) {
    if (detail) console.warn(`[end-reason] missing reason; detail: ${detail}`);
    return t(GENERIC_END);
  }
  const copy = REASON_COPY[reason];
  if (!copy) {
    console.warn(`[end-reason] unmapped reason "${reason}"${detail ? ` (${detail})` : ""}`);
    return t(GENERIC_END);
  }
  // Every reason line is a key in the language files too, so a customer in Spanish reads
  // his own language where one exists and English where a sentence has not been written
  // yet - never a blank toast in the middle of a call.
  return t(copy);
}

// Raw infrastructure noise we must never show a user.
function looksInternal(text: string): boolean {
  if (!text) return true;
  if (/^\s*\d{4,5}\s*$/.test(text)) return true; // bare Postgres SQLSTATE code, e.g. "23505"
  if (/\b(23505|23503|23514|42703|42P01|22P02|40001)\b/.test(text)) return true;
  if (/does not exist|could not find the table|violates|null value in column|new row violates|relation\b|constraint\b|foreign key/i.test(text)) return true;
  if (/^(Stream Live|Stream Studio)\b/i.test(text)) return true; // our own internal throw prefix
  // The server's own wording for a sign-in token it will not accept. It names the
  // token format and tells the customer nothing they can act on, so it never reaches
  // a screen — the page's plain sentence is used instead.
  if (/\bJWT\b|JWS(?:Error|InvalidSignature)|invalid_grant|refresh token/i.test(text)) return true;
  if (/stack|\bat\s+\S+\.\S+\s+\(/.test(text)) return true;
  if (/\n\s{2,}/.test(text)) return true; // multi-line stack traces
  // GoTrue wraps anything the database refuses during sign-up (including a trigger
  // that rejects a malformed address) in its own wording, which names our provider.
  // The refusal is real; the sentence is not something a customer should read.
  if (/database error|saving new user|duplicate key|trigger|function/i.test(text)) return true;
  // Supabase and LiveKit ship upgrade notices that carry their own documentation
  // links inside the error message. A customer screen must never show one.
  if (/https?:\/\//.test(text)) return true;
  if (/wss?:\/\//.test(text)) return true;
  return false;
}

/**
 * Safe user-facing message from any thrown error. Maps GatewayError reasons via
 * endReasonMessage, passes through already-friendly text, and swallows raw
 * gateway/Postgres noise into `fallback` (the original goes to console.warn).
 */
export function toUserMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && typeof (err as { reason?: unknown }).reason === "string") {
    return endReasonMessage((err as { reason: string }).reason);
  }
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (looksInternal(text)) {
    console.warn("[end-reason] raw error suppressed:", text);
    return fallback;
  }
  return text || fallback;
}
