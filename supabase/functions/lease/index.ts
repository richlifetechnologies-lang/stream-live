// POST lease
// Heartbeat for an open call. 'renew' bills the window that just elapsed, refunds
// the unused part of the prepaid chunk and pre-pays the next one; 'media' only stamps
// the instant the first frame reached the screen — a video window is billed from there,
// so a call that never shows a picture costs nothing; 'end' closes the session for
// good. The client MUST stop the call when the answer says ended — that is the moment
// the wallet ran dry.
//
// Body: { sessionId: string, action?: "renew"|"media"|"end" }   (end === action:"end")
// Resp: { ended, balance, unlimited, leaseExpiresAt, billedMinutes, fundedSeconds, lowBalance }
import { preflight, json, fail } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { adminClient } from "../_shared/db.ts";
import { updateLease } from "../_shared/credits.ts";

const LOW_BALANCE_MINUTES = 5;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return fail("method not allowed", 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const action = body.action === "end" || body.end === true
      ? "end"
      : body.action === "media" ? "media" : "renew";
    if (!sessionId) return fail("sessionId is required");

    const { data: session } = await adminClient()
      .from("usage_sessions")
      .select("id, user_id, ended_at, settled, lease_expires_at")
      .eq("id", sessionId)
      .maybeSingle();
    if (!session || session.user_id !== user.id) return fail("session not found", 404);

    if (session.ended_at || session.settled) {
      return json({ ended: true, balance: null, unlimited: false, leaseExpiresAt: null, billedMinutes: null, fundedSeconds: null, lowBalance: false });
    }

    const res = await updateLease(sessionId, action);
    return json({
      ended: res.ended,
      reason: res.reason,
      balance: res.balance,
      unlimited: res.unlimited,
      // 'media' extends nothing, so report the expiry the renew last wrote rather than
      // a fresh one counted from this request.
      leaseExpiresAt: action === "media" ? session.lease_expires_at : res.expiresAt,
      billedMinutes: res.billed,
      // How long the window this renewal just bought pays for airtime, counted from the
      // instant it starts. Null when nothing is being counted down against this call.
      fundedSeconds: res.fundedSeconds,
      lowBalance: res.balance !== null && res.balance <= LOW_BALANCE_MINUTES,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unauthorized";
    const status = /authoriz|session|token/i.test(msg) ? 401 : 500;
    return fail(msg, status);
  }
});
