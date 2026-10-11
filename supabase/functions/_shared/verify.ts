// Proves a pasted key actually works without spending a cent of inference.
//
// fal.ai: mint a throwaway 120-second call token — the exact call a real session
// starts with, so a green light here means the whole handshake will work.
// ElevenLabs: read the account's subscription quota. Both are metadata endpoints;
// neither queues an inference request.
import type { Provider } from "./keys.ts";

export type VerifyResult = { ok: boolean; status: number | null; detail: string };

async function call(input: string, init: RequestInit): Promise<Response | string> {
  try {
    return await fetch(input, init);
  } catch (err) {
    return `could not reach the provider: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function verifyKey(provider: Provider, secret: string): Promise<VerifyResult> {
  const key = secret.trim();
  if (!key) return { ok: false, status: null, detail: "Nothing to test yet — paste the key first." };

  if (provider === "fal") {
    const res = await call("https://rest.fal.ai/tokens/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Key ${key}` },
      body: JSON.stringify({ allowed_apps: ["lucy-2-5"], token_expiration: 120 }),
    });
    if (typeof res === "string") return { ok: false, status: null, detail: res };
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 160);
      return {
        ok: false,
        status: res.status,
        detail: res.status === 401 || res.status === 403
          ? "fal.ai refused this key. Check it was copied in full and is an API key, not a dashboard login."
          : `fal.ai answered ${res.status}. ${body}`,
      };
    }
    return { ok: true, status: 200, detail: "Accepted — fal.ai minted a call token for lucy-2-5." };
  }

  const sub = await call("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key } });
  if (typeof sub === "string") return { ok: false, status: null, detail: sub };
  if (!sub.ok) {
    if (sub.status !== 404) {
      return {
        ok: false,
        status: sub.status,
        detail: sub.status === 401 || sub.status === 403
          ? "ElevenLabs refused this key. It is the string under Profile → API Key, and it never starts with 'sk_'."
          : `ElevenLabs answered ${sub.status}.`,
      };
    }
    // Older / scoped-down keys can't read the subscription; the voice list still
    // proves the key authenticates.
    const voices = await call("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
    if (typeof voices === "string") return { ok: false, status: null, detail: voices };
    if (!voices.ok) return { ok: false, status: voices.status, detail: `ElevenLabs answered ${voices.status}.` };
    const v = await voices.json().catch(() => ({}));
    return { ok: true, status: 200, detail: `Accepted — ${num(v?.voices?.length)} voices visible to this key.` };
  }
  const j = await sub.json().catch(() => ({}));
  const used = num(j?.character_count);
  const limit = num(j?.character_limit);
  return {
    ok: true,
    status: 200,
    detail: `Accepted — ${j?.tier || "ElevenLabs"} tier, ${used.toLocaleString()}${limit ? ` of ${limit.toLocaleString()}` : ""} characters used.`,
  };
}
