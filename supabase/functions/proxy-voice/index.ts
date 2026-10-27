// POST proxy-voice
// The desktop app's only route to ElevenLabs. The master voice key never leaves
// this function — the client sees either streamed audio or a JSON result.
//
// Two access levels:
//   * inference (/v1/speech-to-speech/*, /v1/text-to-speech/*) needs an open lease
//     for a voice modality, i.e. the minutes are already being metered by start-session
//     and lease. Pass { sessionId }.
//   * voice library work (/v1/voices, /v1/voices/add) is setup, not a call: allowed
//     for an active account with audio or video+audio switched on, minutes or not.
//
// The target path is restricted to an allow-list so this cannot become an open proxy.
import { corsHeaders, preflight, json, fail } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { adminClient } from "../_shared/db.ts";
import { readAccount, reapSessions } from "../_shared/credits.ts";
import { runWithKeys } from "../_shared/keys.ts";

/** Deno's clock vs Postgres' now(): refuse a lease only past a small skew window. */
const LEASE_SKEW_MS = 10_000;

/**
 * How long to wait for the voice service to begin answering. This is a time-to-first-answer
 * deadline and nothing more: the timer is disarmed the moment the service starts talking,
 * because a timer left running would also fire in the middle of a live voice.
 */
const FIRST_BYTE_TIMEOUT_MS = 15_000;

const ELEVEN_BASE = "https://api.elevenlabs.io";

const INFER_PREFIXES = ["/v1/speech-to-speech/", "/v1/text-to-speech/"];
const LIBRARY_PATHS = ["/v1/voices", "/v1/voices/add"];

function classify(path: string): "inference" | "library" | null {
  if (INFER_PREFIXES.some((p) => path.startsWith(p))) return "inference";
  if (LIBRARY_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return "library";
  return null;
}

/**
 * The client sends either JSON, plain text, or a pre-serialised multipart body (a
 * FormData it wanted ElevenLabs to see byte-for-byte, base64'd so the boundary and
 * the file bytes survive the hop through this JSON envelope).
 */
function upstreamPayload(body: Record<string, never>): { headers: Record<string, string>; payload?: Uint8Array | string } {
  const mp = body.multipart as { contentType?: string; bodyBase64?: string } | undefined;
  if (mp?.bodyBase64) {
    const binary = atob(mp.bodyBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { headers: { "Content-Type": mp.contentType ?? "multipart/form-data" }, payload: bytes };
  }
  if (typeof body.text === "string") {
    return { headers: { "Content-Type": "text/plain" }, payload: body.text };
  }
  if (body.json !== undefined) {
    return { headers: { "Content-Type": "application/json" }, payload: JSON.stringify(body.json) };
  }
  return { headers: {} };
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
        return fail("session has ended", 403, { reason: "session_ended" });
      }
      if (session.modality !== "audio" && session.modality !== "video_audio") {
        return fail("session does not include voice", 403, { reason: "modality_disabled" });
      }
      // The heartbeat is what keeps a call paid for. If it stopped landing — closed
      // app, lost network, a wallet that ran dry — the lease is past its TTL and
      // every voice call from here on would be billed to our keys and not to them.
      if (session.lease_expires_at && Date.parse(session.lease_expires_at) + LEASE_SKEW_MS < Date.now()) {
        await reapSessions(user.id).catch(() => null);
        return fail("the call stopped checking in and was closed", 403, { reason: "lease_expired" });
      }
    } else {
      // Voice library: setup, not a call, so it must not require a funded bucket —
      // a user has to be able to prepare a voice before the first minute is spent.
      // What it does require is an account the administrator has let use voice at
      // all, so switching audio off for an account also closes its library.
      const audio = await readAccount(user.id, "audio");
      const combined = await readAccount(user.id, "video_audio");
      const allowed = (a: Awaited<ReturnType<typeof readAccount>>) => a.ok;
      const usable = [audio, combined].find(allowed);
      if (!usable) {
        return fail(String(audio.message ?? audio.reason ?? "denied"), 403, {
          reason: audio.reason,
          balances: audio.balances,
        });
      }
    }

    const proxied = await runWithKeys<Response>(user.id, "elevenlabs", async (key) => {
      const { headers, payload } = upstreamPayload(body);
      // A timer that simply expires would fire during the audio as well as before it, so the
      // deadline is held on a controller that is disarmed the moment the service answers.
      const ac = new AbortController();
      const armed = setTimeout(() => ac.abort(), FIRST_BYTE_TIMEOUT_MS);
      let upstream: Response;
      try {
        upstream = await fetch(ELEVEN_BASE + path, {
          method,
          headers: {
            "xi-api-key": key.secret,
            Accept: body.isStream ? "audio/mpeg" : "application/json",
            ...headers,
          },
          body: method === "POST" ? payload : undefined,
          signal: ac.signal,
        });
      } catch (err) {
        clearTimeout(armed);
        return { ok: false, detail: `elevenlabs did not answer: ${err instanceof Error ? err.message : String(err)}` };
      }
      clearTimeout(armed);
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        return { ok: false, status: upstream.status, detail: detail.slice(0, 300) };
      }
      return { ok: true, value: upstream };
    });

    if (!proxied.ok) {
      // The upstream's own wording (and any key detail in it) is already in
      // key_usage_log for the admin panel; the caller gets a plain reason.
      return fail("our voice service did not answer", 502, { reason: "upstream_key" });
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
