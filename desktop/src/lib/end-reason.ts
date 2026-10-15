// One place that turns machine reasons and raw gateway/Postgres errors into a
// short sentence a normal person can read. Anything we cannot explain safely
// becomes a generic sentence and the original goes to console.warn — never to
// the screen.

const GENERIC_END = "Something went wrong, so the call stopped. You weren't charged for it — please try again.";

const REASON_COPY: Record<string, string> = {
  out_of_minutes: "This account has no minutes to call with. Ask your administrator for more from your minutes dashboard.",
  modality_disabled: "This kind of call isn't switched on for your account. Ask your administrator to enable it.",
  no_subscription: "Your account doesn't have a plan yet. Ask your administrator to set one up.",
  status_canceled: "Your administrator cancelled this account.",
  status_past_due: "This account is on hold for payment. Ask your administrator to sort it out.",
  status_expired: "This account is no longer active. Ask your administrator to reactivate it.",
  device_limit_reached: "You've reached the number of devices allowed on this account. Your administrator can free one up for you.",
  device_revoked: "This device was removed by your administrator.",
  concurrent_limit: "You're already on a call. End it before starting another one.",
  lines_busy: "Every video line our provider allows is in use right now. Give it a minute and try again.",
  not_entitled: "This account isn't allowed to make that kind of call. Ask your administrator.",
  maintenance: "The service is being updated. Try again in a little while.",
  update_required: "This version of Stream Live is out of date. Update to keep going.",
  upstream_key: "Our AI service didn't answer. Try again in a minute — you weren't charged.",
  lease_expired: "We lost track of your call and ended it, so you weren't over-charged. Try again.",
  no_lease: "Your call was ended because its booking lapsed. Try starting again.",
  session_not_found: "We couldn't find your session any more, so the call stopped. Try again.",
  connection_lost: "Your internet connection dropped, so the call ended. Check your network and try again.",
  signed_out: "You were signed out. Please sign in again.",
};

/** Plain-English sentence for a gateway/session reason. Unknown reasons never leak to the UI. */
export function endReasonMessage(reason?: string | null, detail?: string): string {
  if (!reason) {
    if (detail) console.warn(`[end-reason] missing reason; detail: ${detail}`);
    return GENERIC_END;
  }
  const copy = REASON_COPY[reason];
  if (!copy) {
    console.warn(`[end-reason] unmapped reason "${reason}"${detail ? ` (${detail})` : ""}`);
    return GENERIC_END;
  }
  return copy;
}

// Raw infrastructure noise we must never show a user.
function looksInternal(text: string): boolean {
  if (!text) return true;
  if (/^\s*\d{4,5}\s*$/.test(text)) return true; // bare Postgres SQLSTATE code, e.g. "23505"
  if (/\b(23505|23503|23514|42703|42P01|22P02|40001)\b/.test(text)) return true;
  if (/does not exist|could not find the table|violates|null value in column|new row violates|relation\b|constraint\b|foreign key/i.test(text)) return true;
  if (/^(Stream Live|Stream Studio)\b/i.test(text)) return true; // our own internal throw prefix
  if (/stack|\bat\s+\S+\.\S+\s+\(/.test(text)) return true;
  if (/\n\s{2,}/.test(text)) return true; // multi-line stack traces
  // GoTrue wraps anything the database refuses during sign-up (including a trigger
  // that rejects a malformed address) in its own wording, which names our provider.
  // The refusal is real; the sentence is not something a customer should read.
  if (/database error|saving new user|duplicate key|trigger|function/i.test(text)) return true;
  // Supabase and LiveKit ship upgrade notices that carry their own documentation
  // links inside the error message. A customer screen must never show one.
  if (/https?:\/\//.test(text)) return true;
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
