// POST proxy-voice
// The desktop app's only route to ElevenLabs. The master voice key never leaves
// this function — the client sees either streamed audio or a JSON result.
//
// Two access levels:
//   * inference (/v1/speech-to-speech/*, /v1/text-to-speech/*) needs an open lease
//     for a voice modality, i.e. the minutes are already being metered by start-session
//     and lease. Pass { sessionId }.
//   * voice library work (/v1/voices, /v1/voices/add) is setup, not a call: allowed
//     for an active account whose audio or video+audio bucket is enabled and non-zero.
//
// The target path is restricted to an allow-list so this cannot become an open proxy.
import { corsHeaders, preflight, json, fail } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { adminClient } from "../_shared/db.ts";
import { readAccount } from "../_shared/credits.ts";
import { runWithKeys } from "../_shared/keys.ts";

const ELEVEN_BASE = "https://api.elevenlabs.io";

const INFER_PREFIXES = ["/v1/speech-to-speech/", "/v1/text-to-speech/"];
const LIBRARY_PATHS = ["/v1/voices", "/v1/voices/add"];

function classify(path: string): "inference" | "library" | null {
  if (INFER_PREFIXES.some((p) => path.startsWith(p))) return "inference";
  if (LIBRARY_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return "library";
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return fail("method not allowed", 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const path = typeof body.path === "string" ? body.path : "";
    const method = body.method === "GET" ? "GET" : "POST";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";

    const kind = classify(path);
    if (!kind) return fail("path not allowed", 403);

    const db = adminClient();

    if (kind === "inference") {
      if (!sessionId) return fail("sessionId is required", 400, { reason: "no_lease" });
      const { data: session } = await db
        .from("usage_sessions")
        .select("id, user_id, modality, ended_at, settled, lease_expires_at")
        .eq("id", sessionId)
        .maybeSingle();
      if (!session || session.user_id !== user.id) return fail("session not found", 404);
      if (session.ended_at || session.settled) {
        return fail("session has ended", 403, { reason: "out_of_minutes" });
      }
      if (session.modality !== "audio" && session.modality !== "video_audio") {
        return fail("session does not include voice", 403, { reason: "modality_disabled" });
      }
    } else {
      // Voice library: still needs an account that may use voice at all.
      const audio = await readAccount(user.id, "audio");
      const combined = await readAccount(user.id, "video_audio");
      const usable = [audio, combined].find((a) => a.ok);
      if (!usable) {
        return fail(String(audio.reason ?? "denied"), 403, {
          reason: audio.reason,
          balances: audio.balances,
        });
      }
    }

    const proxied = await runWithKeys<Response>(user.id, "elevenlabs", async (key) => {
      const upstream = await fetch(ELEVEN_BASE + path, {
        method,
        headers: {
          "xi-api-key": key.secret,
          "Content-Type": "application/json",
          Accept: body.isStream ? "audio/mpeg" : "application/json",
        },
        body: method === "POST" && body.body !== undefined ? JSON.stringify(body.body) : undefined,
      });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        return { ok: false, status: upstream.status, detail: detail.slice(0, 300) };
      }
      return { ok: true, value: upstream };
    });

    if (!proxied.ok) {
      return fail(proxied.error ?? "elevenlabs request failed", 502, { reason: "upstream_key" });
    }
    const upstream = proxied.value as Response;

    // Stream audio back verbatim; otherwise pass JSON through.
    const ct = upstream.headers.get("content-type") ?? "";
    const headers: Record<string, string> = { ...corsHeaders, "Content-Type": ct || "application/json" };
    if (ct.startsWith("audio/") || body.isStream) {
      return new Response(upstream.body, { status: upstream.status, headers });
    }
    return new Response(await upstream.text(), { status: upstream.status, headers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unauthorized";
    const status = /authoriz|session|token/i.test(msg) ? 401 : 500;
    return fail(msg, status);
  }
});
