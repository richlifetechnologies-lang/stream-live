// Proves a pasted key actually works without spending a cent of inference.
//
// fal.ai: mint a throwaway 120-second call token — the exact call a real session
// starts with, so a green light here means the whole handshake will work.
// ElevenLabs: read the account's subscription quota. Both are metadata endpoints;
// neither queues an inference request.
import { normalizeSecret, type Provider } from "./keys.ts";

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
  const key = normalizeSecret(secret);
  if (!key) return { ok: false, status: null, detail: "Nothing to test yet — paste the key first." };

  if (provider === "fal") {
    // fal authenticates on the dashboard pair `<key id>:<key secret>`, so the shape
    // of what we are about to send is itself the diagnosis. Report lengths only —
    // never the key.
    const [id, ...rest] = key.split(":");
    const shape = rest.length === 0
      ? `${key.length} characters with no ':' — a fal credential is the dashboard pair "<key id>:<key secret>"`
      : `id ${id.length} chars + secret ${rest.join(":").length} chars`;
    if (rest.length === 0) {
      return {
        ok: false,
        status: null,
        detail: `fal.ai needs both halves of the key. Copied: ${shape}. Put it back as one line, id:secret.`,
      };
    }

    // Ask for the app this product actually opens. Minting against the bare name the
    // desktop used to send proved only that the key authenticates, which is why a key
    // that could never serve a call still read as live on the panel.
    const res = await call("https://rest.fal.ai/tokens/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Key ${key}` },
      body: JSON.stringify({ allowed_apps: ["decart/lucy-2-5"], token_expiration: 120 }),
    });
    if (typeof res === "string") return { ok: false, status: null, detail: res };
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      let why = body;
      try {
        const j = JSON.parse(body);
        why = typeof j?.detail === "string" ? j.detail : body;
      } catch { /* not JSON — show it raw */ }
      return {
        ok: false,
        status: res.status,
        detail: `fal.ai answered ${res.status}${why ? `: ${why}` : ""}. Sent ${shape}.`,
      };
    }
    return { ok: true, status: 200, detail: "Accepted — fal.ai minted a call token for decart/lucy-2-5, the app this product runs." };
  }

  if (provider === "decart") {
    // Minting a client token is the cheapest proof that this key authenticates and
    // that the model the app dials is reachable: a real session starts the same way.
    // It costs nothing and queues no inference.
    const res = await call("https://api.decart.ai/v1/client/tokens", {
      method: "POST",
      headers: { "X-API-KEY": key, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: 60, allowedModels: ["lucy-2.5"] }),
    });
    if (typeof res === "string") return { ok: false, status: null, detail: res };
    const raw = await res.text().catch(() => "");
    // A client token is a JWT, so the JSON body is far longer than anything worth
    // putting in a log line. Truncate only what gets displayed — parsing the
    // clipped copy always failed, which made a working key look rejected.
    const body = raw.slice(0, 200);
    if (!res.ok) {
      return { ok: false, status: res.status, detail: `Decart answered ${res.status}${body ? `: ${body}` : ""}. Sent ${key.length} characters.` };
    }
    let token = "";
    try { token = String(JSON.parse(raw)?.apiKey ?? ""); } catch { /**/ }
    if (token.length < 20) return { ok: false, status: res.status, detail: `Decart accepted the key but returned no client token (${body || "empty body"}).` };
    return { ok: true, status: 200, detail: "Accepted — Decart minted a client token for lucy-2.5." };
  }

  const sub = await call("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key } });
  if (typeof sub === "string") return { ok: false, status: null, detail: sub };
  if (!sub.ok) {
    if (sub.status !== 404) {
      const body = (await sub.text().catch(() => "")).slice(0, 200);
      return {
        ok: false,
        status: sub.status,
        detail: `ElevenLabs answered ${sub.status}${body ? `: ${body}` : ""}. Sent ${key.length} characters.`,
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
