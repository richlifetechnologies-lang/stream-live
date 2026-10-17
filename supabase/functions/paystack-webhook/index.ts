// paystack-webhook — the only thing that may turn money into minutes.
//
// Paystack POSTs here when a card is charged. Two defences, in this order:
//
//   1. The body is signed. Paystack puts an HMAC-SHA512 of the exact raw bytes in
//      `x-paystack-signature`, keyed with the secret key. The body is read as text
//      FIRST, because re-serialising it would change the bytes and break the
//      signature.
//   2. The signature is not enough on its own: it proves the body came from
//      Paystack, not that the payment is real and complete. So the transaction is
//      fetched back from Paystack by reference and only its answer is believed.
//
// Crediting itself is one RPC call, and that call is what makes it safe to retry:
// a payment row can only ever be credited once, so Paystack's repeated deliveries
// are harmless.
//
// Status codes matter here. 200 means "stop retrying"; anything else makes
// Paystack try again for hours. So a permanent refusal (unknown order, amount
// mismatch) is acknowledged with 200 and written to the order, while a genuine
// infrastructure failure answers 500 and lets the retry land it.
import { adminClient } from "../_shared/db.ts";
import { preflight, json, fail } from "../_shared/cors.ts";
import { markRefunded, moneyReturned, returnedWhy, type PaystackTxn } from "../_shared/paystack-reconcile.ts";

const API = "https://api.paystack.co";
const TIMEOUT_MS = 15_000;

function secretKey(): string {
  const s = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
  if (!s.startsWith("sk_test_") && !s.startsWith("sk_live_")) {
    throw new Error("PAYSTACK_SECRET_KEY is not set on this function");
  }
  return s;
}

async function hexHmac(key: string, message: string): Promise<string> {
  const raw = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", raw, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compared by XOR over every character: never by `===` on attacker-supplied text. */
function signatureMatches(expected: string, given: string): boolean {
  if (!given || expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") return fail("use POST", 405);

  const key = secretKey();
  const body = await req.text();
  const expected = await hexHmac(key, body);
  if (!signatureMatches(expected, (req.headers.get("x-paystack-signature") ?? "").trim())) {
    console.error("paystack-webhook: signature did not match — ignored");
    return fail("bad signature", 400);
  }

  const event = JSON.parse(body) as { event?: string; data?: Record<string, unknown> };
  const name = event.event ?? "";
  if (name !== "charge.success") return json({ ok: true, ignored: name });

  const reference = String(event.data?.reference ?? "");
  if (!/^[A-Za-z0-9_.-]{6,64}$/.test(reference)) return json({ ok: true, ignored: "not one of ours" });

  // Ask Paystack itself. This is the answer that moves money, not the POST body.
  const res = await fetch(`${API}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const fetched = await res.json().catch(() => null);
  if (fetched?.status !== true || !fetched.data) {
    console.error(`paystack verify ${reference}: HTTP ${res.status} ${fetched?.message ?? "no answer"}`);
    return fail("could not confirm the payment", 500);   // let Paystack retry
  }

  const txn = fetched.data as Record<string, unknown> & PaystackTxn;
  // A charge Paystack has refunded still verifies as success, and a mobile-money reversal
  // arrives as its own state. Either way the money is back with the payer, so the order is
  // closed as refunded instead of buying minutes.
  if (moneyReturned(txn)) {
    await markRefunded(reference, returnedWhy(txn), String(txn.id ?? ""));
    console.log(`paystack settle ${reference}: money returned (${String(txn.status)}/${String(txn.refund_status)}) — nothing credited`);
    return json({ ok: true, reference, refunded: true });
  }
  // A reference this gateway issued is an order we opened, so the package and the
  // account are already on file. Anything else came through a Paystack payment
  // page, where the amount and the payer's email are all there is to go on.
  const ours = /^sl-[0-9a-f]{12,24}$/.test(reference);
  const { data, error } = await adminClient().rpc(ours ? "sl_paystack_settle" : "sl_paystack_page_credit", {
    p_reference: reference,
    p_txn: {
      id: String(txn.id ?? ""),
      status: txn.status,
      amount: txn.amount,
      currency: txn.currency,
      domain: txn.domain,
      paid_at: txn.paid_at,
      channel: txn.channel,
      refund_status: txn.refund_status ?? "",
      customer: txn.customer ?? null,
    },
  });
  if (error) {
    console.error(`paystack settle ${reference}: ${error.message}`);
    return fail("the credit could not be written", 500);  // retry, the order is still creditable
  }

  const result = (data ?? {}) as Record<string, unknown>;
  if (result.ok !== true) {
    // A permanent no: recorded on the order by the RPC itself. Retrying cannot fix it.
    console.error(`paystack settle ${reference} refused: ${result.error} ${result.message ?? ""}`);
    return json({ ok: false, error: result.error, reference });
  }
  console.log(`paystack settle ${reference}: credited ${JSON.stringify(result.grants)}`);
  return json({ ok: true, reference, deduped: result.deduped === true });
}

Deno.serve((req) => (req.method === "OPTIONS" ? preflight() : handle(req).catch((e) => {
  console.error("paystack-webhook:", e?.message ?? e);
  return fail("the payment service had a problem", 500);
})));
