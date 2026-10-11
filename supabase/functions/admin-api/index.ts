// POST admin-api
// The admin panel runs in a browser with the anon key + the admin's own JWT, so it
// cannot reach the service-role money RPCs directly. This function is that bridge:
// it proves the caller is an admin, then performs the one operation asked for.
//
// Body: { action: string, ... }
//   grant         { userId, modality, minutes, reason, unlimited? }
//   end_session   { sessionId }
//   resolve       { requestId, approve, note?, minutes? }
//   reap          { userId? }
//   signout       { userId }                 -- kill every refresh token
// Resp: { ok:true, ...result } or { error, status }
import { preflight, json, fail } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { adminClient } from "../_shared/db.ts";
import { grantCredits, reapSessions, resolveRequest, signOutEverywhere, updateLease, type Modality } from "../_shared/credits.ts";

const MODALITIES = ["video", "audio", "video_audio"];

async function requireAdmin(userId: string): Promise<boolean> {
  const { data } = await adminClient()
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();
  return data?.is_admin === true;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return fail("method not allowed", 405);

  try {
    const user = await requireUser(req);
    if (!(await requireAdmin(user.id))) return fail("admin only", 403);

    const body = await req.json().catch(() => ({}));
    const action = typeof body.action === "string" ? body.action : "";

    switch (action) {
      case "grant": {
        const modality = String(body.modality ?? "");
        const minutes = Number(body.minutes);
        if (!MODALITIES.includes(modality)) return fail("modality must be video, audio or video_audio");
        if (!Number.isFinite(minutes)) return fail("minutes must be a number");
        if (String(body.reason || "").trim().length < 3) return fail("a reason is required (audit trail)");
        const res = await grantCredits(
          String(body.userId),
          modality as Modality,
          minutes,
          String(body.reason),
          user.id,
          { unlimited: body.unlimited === true || body.unlimited === false ? body.unlimited : null },
        );
        return json({ ok: true, ...res });
      }

      case "end_session": {
        const res = await updateLease(String(body.sessionId), "end");
        return json({ ok: res.ok, ...res });
      }

      case "resolve": {
        const res = await resolveRequest(
          String(body.requestId),
          body.approve === true,
          user.id,
          body.note ? String(body.note) : undefined,
          body.minutes !== undefined && body.minutes !== null ? Number(body.minutes) : undefined,
        );
        return json({ ok: true, ...res });
      }

      case "reap": {
        const closed = await reapSessions(body.userId ? String(body.userId) : undefined);
        return json({ ok: true, closed });
      }

      case "signout": {
        const target = String(body.userId);
        const sessions = await signOutEverywhere(target);
        // Also close anything still leasing so the minute counter stops.
        const closed = await reapSessions(target);
        return json({ ok: true, sessions, closed });
      }

      default:
        return fail(`unknown action: ${action || "(none)"}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unauthorized";
    const status = /authoriz|session|token/i.test(msg) ? 401 : 500;
    return fail(msg, status);
  }
});
