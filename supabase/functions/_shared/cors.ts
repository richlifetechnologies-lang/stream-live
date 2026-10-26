// Shared CORS helpers for Supabase Edge Functions.
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export function preflight(): Response {
  return new Response("ok", { headers: corsHeaders });
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  // Every answer carries the gateway's own clock. A machine whose clock runs ahead throws
  // away its call pass before it ever dials, and nothing read off that machine can tell
  // "your clock" apart from "the line is broken" — so the true time is stamped once here
  // instead of being added to whichever route happens to fail today.
  const withTime = body && typeof body === "object" && !Array.isArray(body)
    ? { serverTimeMs: Date.now(), ...(body as Record<string, unknown>) }
    : body;
  return new Response(JSON.stringify(withTime), {
    ...init,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export function fail(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, { status });
}
