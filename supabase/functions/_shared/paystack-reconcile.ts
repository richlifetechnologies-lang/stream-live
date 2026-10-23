// Asking Paystack, straight from the server, whether the money is in — and crediting
// an order from that answer.
//
// Two things used to have to go right for a payment to credit: the seller's Paystack
// settings had to carry this gateway's webhook address, and the buyer had to keep the
// confirm page open while it polled. Either one missing left a customer who had paid
// staring at "Confirming your payment" with the money gone from their wallet, which is
// the worst possible failure this product can have.
//
// This module removes the dependency. Anyone who can name an order can have it checked
// against Paystack: the buyer's own page, the app on the payer's account, and the
// seller's Payments tab. Settling is already safe to repeat, because an order can only
// ever be credited once, so a re-check costs one request and can never pay anybody out
// twice.
//
// Nothing here is allowed to fail quietly. Every answer comes back with a reason the
// person asking can read, because "the app says pending and Paystack says success" was
// unanswerable while every refusal was swallowed.
import { adminClient } from "./db.ts";

const API = "https://api.paystack.co";
const TIMEOUT_MS = 15_000;

export type PaystackTxn = {
  id?: string;
  status?: string;
  amount?: number;
  currency?: string;
  domain?: string;
  paid_at?: string;
  channel?: string;
  refund_status?: string;
  customer?: Record<string, unknown> | null;
};

/**
 * "The money went back to the payer."
 *
 * A transaction Paystack has refunded still verifies as `success` - the charge happened -
 * with the refund carried in a separate field. A mobile-money **reversal** is different
 * again: the transaction's own state becomes `reversed`. Both mean the same thing for this
 * gateway, and both were seen on the live account, so both are handled here. Without this
 * a re-check would happily hand out minutes for money the customer already has back in
 * their wallet, which is the one way this gateway can lose the seller real money.
 */
export function refundState(txn: PaystackTxn): string | null {
  const s = String(txn.refund_status ?? "").toLowerCase();
  return s === "processed" || s === "ok" || s === "success" ? s : null;
}

/** True when Paystack has put this money back with the payer, by refund or by reversal. */
export function moneyReturned(txn: PaystackTxn): boolean {
  return refundState(txn) !== null || String(txn.status ?? "").toLowerCase() === "reversed";
}

/** The cause, in the payer's own words, of a payment that is no longer money we have. */
export function returnedWhy(txn: PaystackTxn): string {
  return String(txn.status ?? "").toLowerCase() === "reversed"
    ? "Paystack reversed this payment back to the payer's wallet"
    : "Paystack refunded this payment to the payer";
}

/**
 * Money that came back takes its minutes with it.
 *
 * The database owns that arithmetic, because it is the only thing that knows what was actually
 * delivered: the take-back works from the ledger entries the delivery wrote with this order's
 * reference on them. It is safe to call twice - an order that was never credited is simply
 * closed as returned, and one already closed does nothing.
 *
 * A failure here never guesses at a number. The order is left exactly as it stands and the
 * reason comes back in words, because taking minutes from someone who did pay would be worse
 * than a refund the seller settles once, in the open.
 */
export async function clawBack(reference: string, why: string, paystackId = ""): Promise<string> {
  const { data, error } = await adminClient().rpc("sl_paystack_clawback", {
    p_reference: reference, p_reason: why,
  });
  if (error) {
    console.error(`paystack clawback ${reference}: ${error.message}`);
    return `the take-back could not run: ${error.message}`;
  }
  const res = (data ?? {}) as Record<string, unknown>;
  if (res.ok !== true) {
    console.error(`paystack clawback ${reference} refused: ${String(res.error ?? "no reason")}`);
    return `the take-back refused: ${String(res.error ?? "no reason")}`;
  }
  if (res.deduped === true) return "this order was already closed as returned";
  if (res.clawed === true) return `minutes taken back: ${JSON.stringify(res.taken)}`;
  if (res.orphan === true) return "no account was recorded on this order, so there was nothing to take back";
  return "nothing had been credited on this order, so nothing was owed";
}

/** Writes the refund onto the order so the seller's Payments tab and the receipt both say so. */
export async function markRefunded(
  reference: string,
  why: string,
  paystackId = "",
): Promise<void> {
  // This one only closes an order that never delivered anything. A credited order belongs to
  // clawBack above, which takes the minutes back from the ledger entries the delivery wrote.
  const patch: Record<string, unknown> = { status: "refunded", note: why };
  // Paystack's own number is what the seller searches his till with, and a closed order
  // never got one until a re-check asked - the receipt has to be able to show it.
  if (paystackId.length) patch.paystack_id = paystackId;
  const { error } = await adminClient()
    .from("payments")
    .update(patch)
    .eq("reference", reference)
    .neq("status", "credited");
  if (error) console.error(`paystack refund mark ${reference}: ${error.message}`);
}

export type Outcome = {
  reference: string;
  /** credited | waiting | refused | not_paid | unchecked */
  result: string;
  /** What to show a human: Paystack's own state, or the reason the credit was refused. */
  detail: string;
};

function secretKey(): string | null {
  const s = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
  return s.startsWith("sk_test_") || s.startsWith("sk_live_") ? s : null;
}

/** The payload the settle RPCs take, from either Paystack's verify answer or a webhook body. */
function txnPayload(txn: PaystackTxn): Record<string, unknown> {
  return {
    id: String(txn.id ?? ""),
    status: txn.status,
    amount: txn.amount,
    currency: txn.currency,
    domain: txn.domain,
    paid_at: txn.paid_at,
    channel: txn.channel,
    refund_status: txn.refund_status ?? "",
    customer: txn.customer ?? null,
  };
}

async function verify(reference: string, key: string): Promise<{ txn: PaystackTxn | null; detail: string }> {
  let res: Response;
  try {
    res = await fetch(`${API}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { txn: null, detail: `Paystack could not be reached: ${e?.message ?? e}` };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.status !== true || !body.data) {
    return { txn: null, detail: `Paystack answered HTTP ${res.status}: ${body?.message ?? "no answer"}` };
  }
  const txn = body.data as PaystackTxn;
  return { txn, detail: `Paystack says ${String(txn.status ?? "unknown")}` };
}

/**
 * Check one order with Paystack and credit it if the money is in.
 *
 * `settling` refuses anything that does not match the order this gateway opened — the
 * amount, the currency, the test/live mode — and each refusal is written on the order and
 * carried back here, so a stuck payment arrives with its own explanation.
 */
export async function settleByReference(reference: string): Promise<Outcome> {
  const base: Outcome = { reference, result: "unchecked", detail: "" };
  const key = secretKey();
  if (!key) return { ...base, detail: "This server has no Paystack secret key, so it cannot ask Paystack anything." };

  const { txn, detail } = await verify(reference, key);
  if (!txn) return { ...base, result: "unchecked", detail };
  // Returned money first: Paystack still calls a refunded charge a success, and a reversal
  // arrives as its own state, so this has to be settled before anything decides the money
  // is here.
  if (moneyReturned(txn)) {
    const why = returnedWhy(txn);
    const did = await clawBack(reference, why, String(txn.id ?? ""));
    return { ...base, result: "refunded", detail: `Paystack put this money back with the payer; ${did}.` };
  }
  if (txn.status !== "success") {
    // Not yet, or never. Pending mobile money is a normal wait and must not be marked failed.
    return { ...base, result: txn.status === "failed" || txn.status === "invalid" ? "not_paid" : "waiting", detail };
  }

  const db = adminClient();
  // An order this gateway opened is credited by its own package; anything else came
  // through a Paystack-hosted page and is credited from the amount and the email.
  const ours = /^sl-[0-9a-f]{12,24}$/.test(reference);
  const rpc = ours ? "sl_paystack_settle" : "sl_paystack_page_credit";
  const { data, error } = await db.rpc(rpc, { p_reference: reference, p_txn: txnPayload(txn) });
  if (error) {
    console.error(`paystack settle ${reference}: ${error.message}`);
    return { ...base, result: "unchecked", detail: `The credit could not be written: ${error.message}` };
  }
  const res = (data ?? {}) as Record<string, unknown>;
  if (res.ok === true) {
    return { ...base, result: "credited", detail: res.deduped === true ? "Already credited earlier." : "Minutes granted." };
  }
  return { ...base, result: "refused", detail: `Paystack has the money but the credit was refused: ${String(res.error ?? "no reason given")}` };
}

/**
 * Re-check the orders that are owed an answer.
 *
 * `p_email` narrows it to one person's own unpaid orders — that is what lets the app fix
 * its own customer without any help from the seller. Left out, it is the seller's repair
 * button over everything on the waiting list.
 *
 * An order already confirmed by Paystack but not credited sits in 'paid' and is included
 * on purpose: that is the state where money has left a wallet and no minutes have
 * arrived, and re-running the credit is how it gets emptied without a hand in the database.
 */
export async function reconcilePending(email?: string | null, limit = 25): Promise<Outcome[]> {
  const db = adminClient();
  const { data, error } = await db.rpc("sl_paystack_open_orders", {
    p_email: email && email.length ? email.toLowerCase() : null,
    p_limit: Math.max(1, Math.min(50, Math.round(limit))),
  });
  if (error) throw new Error(error.message);

  const refs = (data ?? []) as Array<{ reference: string }>;
  const out: Outcome[] = [];
  // One at a time: this runs inside a request, and Paystack's own rate limit is per key.
  for (const row of refs) out.push(await settleByReference(row.reference));
  return out;
}

/**
 * Where Paystack sends its "this payment is done" call-back, and whether it is set at all.
 *
 * An empty box here is the single most common reason a payment sits uncredited: Paystack
 * took the money, told nobody, and this gateway has no reason to believe the order is paid.
 * So the seller's Payments tab asks, and shows the answer next to the orders it explains.
 */
export async function webhookState(): Promise<{ url: string; detail: string }> {
  const key = secretKey();
  if (!key) return { url: "", detail: "This server has no Paystack secret key." };
  try {
    const res = await fetch(`${API}/webhook`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.status !== true) {
      return { url: "", detail: `Paystack answered HTTP ${res.status}: ${body?.message ?? "no answer"}` };
    }
    // Paystack keeps one address per mode; whichever one is filled in is the one it calls.
    const live = String(body.data?.live_url ?? "").trim();
    const test = String(body.data?.test_url ?? "").trim();
    return { url: live || test, detail: live ? `Paystack is calling ${live}` : test ? `Only the test address is set: ${test}` : "No call-back address is registered with Paystack." };
  } catch (e) {
    return { url: "", detail: `Paystack could not be reached: ${e?.message ?? e}` };
  }
}

/**
 * Hand Paystack the address to call. This overwrites whatever is in that box, so it is
 * only ever done when the seller presses the button that says so.
 *
 * Paystack does not offer this everywhere, and an account that has it switched off will
 * say so in words; that answer is passed straight back rather than dressed up as a
 * success, because the seller still has to fill the box by hand in that case.
 */
export async function webhookRegister(url: string): Promise<{ ok: boolean; detail: string }> {
  const key = secretKey();
  if (!key) return { ok: false, detail: "This server has no Paystack secret key." };
  try {
    const res = await fetch(`${API}/webhook`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.status === true) {
      return { ok: true, detail: `Paystack now calls ${url}. ${body.message ?? ""}`.trim() };
    }
    return {
      ok: false,
      detail: `Paystack refused (${res.status}): ${body?.message ?? "no answer"}. Type the address into Settings → API Keys & Webhooks yourself.`,
    };
  } catch (e) {
    return { ok: false, detail: `Paystack could not be reached: ${e?.message ?? e}` };
  }
}
