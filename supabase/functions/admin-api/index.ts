// POST admin-api
// The admin panel runs in a browser with the anon key + the admin's own JWT, so it
// cannot reach the service-role money RPCs directly. This function is that bridge:
// it proves the caller is an admin, then performs the one operation asked for.
//
// Body: { action: string, ... }
//   grant         { userId, modality, minutes, reason, unlimited? }
//   end_session   { sessionId }
//   resolve       { requestId, approve, note?, minutes? }
//   reap          { userId? }                 -- close expired leases
//   signout       { userId }                 -- kill every refresh token
//   test_key      { provider, key? , keyId? } -- prove a key works, no inference billed
// Resp: { ok:true, ...result } or { error, status }
import { preflight, json, fail } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { adminClient } from "../_shared/db.ts";
import { grantCredits, reapSessions, resolveRequest, signOutEverywhere, updateLease, type Modality } from "../_shared/credits.ts";
import { verifyKey, type Provider } from "../_shared/verify.ts";

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
        // The RPC refuses a repeat of the same grant within a few seconds; say so
        // rather than reporting a success that changed nothing.
        if (res.ok !== true) return fail(String(res.error ?? "grant refused"), 409, { deduped: res.deduped === true });
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

      case "test_key": {
        const provider = body.provider === "elevenlabs" ? "elevenlabs" : body.provider === "fal" ? "fal" : null;
        if (!provider) return fail("provider must be fal or elevenlabs");
        const keyId = typeof body.keyId === "string" && body.keyId ? body.keyId : null;
        let secret = typeof body.key === "string" ? body.key : "";
        if (!secret.trim() && keyId) {
          const column = provider === "fal" ? "fal_key" : "elevenlabs_key";
          const { data } = await adminClient().from("gateway_keys").select(column).eq("id", keyId).maybeSingle();
          secret = String((data as Record<string, string | null> | null)?.[column] ?? "");
        }
        if (!secret.trim()) return fail("Nothing to test — paste a key, or save it first and verify the stored copy.");
        const res = await verifyKey(provider as Provider, secret);
        // Logged, but deliberately not through sl_report_key_use: a manual check
        // says nothing about this key's daily burn and must not clear a real
        // last_error that a live call recorded.
        if (keyId) {
          await adminClient().from("key_usage_log").insert({
            key_id: keyId,
            provider,
            user_id: null,
            outcome: res.ok ? "ok" : "fail",
            status: res.status,
            detail: `verify: ${res.detail}`,
          });
        }
        return json({ ok: true, provider, verified: res.ok, status: res.status, detail: res.detail });
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
