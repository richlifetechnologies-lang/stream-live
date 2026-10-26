// POST server-time
// The gateway's own clock, for a machine that cannot trust its own. A computer whose clock
// runs ahead reads its fresh call pass as already spent and refuses to dial at all, which
// looks exactly like a dead video line — so the app takes its time from here, at start-up,
// before it makes any decision that depends on a clock. Asked before sign-in, so this route
// needs no session and touches no wallet.
//
// Body: {}    Resp: { ok: true, serverTimeMs }
import { preflight, json, fail } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return fail("method not allowed", 405);
  return json({ ok: true });
});
