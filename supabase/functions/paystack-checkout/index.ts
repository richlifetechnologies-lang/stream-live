// paystack-checkout — the buyer's door to an online payment.
//
//   GET  /                       -> the packages on sale and how they can be paid for
//   GET  /?check=<reference>     -> how that one payment is doing, asked of Paystack itself
//   POST / { email, plan_id, method } -> opens the payment, returns Paystack's page
//   POST / { reconcile: true }   -> with the app's own sign-in: settle every order that
//                                   address has paid for and not been credited for
//
// method is 'card' or 'mobile_money'. Either way the buyer is handed to Paystack's
// own screen, which is where the card number or the wallet number is typed and
// where the network (MTN MoMo, Telecel Cash, AT Money) is chosen — Paystack shows
// only the ones switched on for this account, so this server never keeps a list of
// networks that could go out of date.
//
// The page that calls this is a plain web page with no login, so the buyer types
// the email address their account was made with. That address is not a
// credential: typing someone else's can only ever buy minutes for that other
// person, and only after money has genuinely been taken. An order is never credited
// from what this page posts — only from Paystack's own answer about that reference,
// which is what the re-check below asks for.
//
// The secret key never leaves the function's environment, and the buyer is sent
// to Paystack's own screen, so no card number ever reaches this server.
import { adminClient } from "../_shared/db.ts";
import { preflight, json, fail } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { reconcilePending, settleByReference } from "../_shared/paystack-reconcile.ts";

const API = "https://api.paystack.co";
const TIMEOUT_MS = 15_000;

function secretKey(): string {
  const s = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
  if (!s.startsWith("sk_test_") && !s.startsWith("sk_live_")) {
    throw new Error("PAYSTACK_SECRET_KEY is not set on this function");
  }
  return s;
}

/** 'test' or 'live', read off the key in use, so test money can never credit a live order. */
function integration(key: string): "test" | "live" {
  return key.startsWith("sk_test_") ? "test" : "live";
}

/**
 * The address this page is published at, as configured on the server. It is the address
 * the buyer is sent back to, so it is also the address a seller would hand out — and the
 * admin panel reads it from here rather than from a box somebody has to keep in sync.
 */
function pageUrl(): string {
  return (Deno.env.get("CHECKOUT_RETURN_URL") ?? "").replace(/\/+$/, "");
}

function newReference(): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return "sl-" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function cleanEmail(raw: unknown): string | null {
  const e = String(raw ?? "").trim().toLowerCase();
  if (e.length < 6 || e.length > 200) return null;
  return /^[^\s@,;:<>"'\\]+@[^\s@,;:<>"'\\.]+(\.[^\s@,;:<>"'\\.]+)+$/.test(e) ? e : null;
}

async function paystack(path: string, key: string, body?: Record<string, unknown>) {
  const res = await fetch(API + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const jsonBody = await res.json().catch(() => null);
  return { status: res.status, body: jsonBody };
}

/**
 * Everything the seller lists, with the two ways they may pay for it: every package
 * switched on in the app, each with its cedi price worked out from the dollar price at
 * the live exchange figure, and a flag saying whether money can actually be taken for it
 * here. The page never has to be edited when he adds or re-prices a package —
 * sl_paystack_packages reads the same table the app's Plans screen does.
 */
async function packages() {
  const { data, error } = await adminClient().rpc("sl_paystack_packages");
  if (error) throw new Error(error.message);
  const shelf = (data?.packages ?? []) as Array<Record<string, unknown>>;
  const channels = Array.isArray(data?.channels)
    ? data.channels.filter((c: unknown) => c === "card" || c === "mobile_money")
    : [];
  return {
    enabled: data?.enabled === true,
    currency: "GHS",
    rate: Number(data?.ghs_per_usd ?? 12),
    page: pageUrl(),
    channels: channels.length ? channels : ["card"],
    packages: shelf,
  };
}

/** The buyer's choice of how to pay, or null when it is not one of the two open doors. */
function chosenMethod(raw: unknown, open: string[]): "card" | "mobile_money" | null {
  const m = String(raw ?? "").trim().toLowerCase();
  if (m !== "card" && m !== "mobile_money") return null;
  return open.includes(m) ? m : null;
}

/**
 * Ask Paystack directly about an order that still looks unpaid, and credit it from that
 * answer if the money is in.
 *
 * This is the second string to the bow. The webhook is the fast path, but it lives in the
 * seller's Paystack settings, and an empty or mistyped box there would otherwise leave a
 * customer who has paid staring at "confirming" for ever. Settling is already safe to call
 * twice — an order can only ever be credited once — so chasing on every poll costs one
 * request and can never pay anybody out twice.
 *
 * Every answer comes back as a sentence, including the ones that change nothing, because
 * "pending here, success over there" was unanswerable while a refusal returned quietly.
 */
async function chase(reference: string): Promise<{ result: string; detail: string }> {
  const out = await settleByReference(reference);
  console.log(`paystack chase ${reference}: ${out.result} — ${out.detail}`);
  return { result: out.result, detail: out.detail };
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const db = adminClient();
    const check = url.searchParams.get("check");
    if (check) {
      if (!/^sl-[0-9a-f]{12,24}$/.test(check)) return fail("that reference is not one of ours", 400);
      let { data, error } = await db.rpc("sl_paystack_status", { p_reference: check });
      if (error) return fail(error.message, 500);
      // 'pending' means nothing has confirmed it yet; 'paid' means Paystack has and the
      // credit was refused. Both are worth asking about, and an order that has just been
      // asked about is throttled by the stamp on it rather than here.
      if (data?.status === "pending" || data?.status === "paid") {
        const said = await chase(check);
        ({ data, error } = await db.rpc("sl_paystack_status", { p_reference: check }));
        if (error) return fail(error.message, 500);
        return json({ ...(data ?? {}), paystack_says: said.detail, chase: said.result });
      }
      return json(data ?? { ok: false, error: "unknown_reference" });
    }
    return json(await packages());
  }

  if (req.method !== "POST") return fail("use GET for the package list, POST to pay", 405);

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail("send a JSON body", 400);

  // The app asks for its own customer's stuck payments. Whoever calls this has already
  // proved who they are, so the answer is limited to orders paid for under that same
  // address — nobody can use it to poke at somebody else's money.
  if (body.reconcile === true) {
    const user = await requireUser(req);
    if (!user.email) return fail("this sign-in has no email address to check payments against", 403);
    const done = await reconcilePending(user.email, 10);
    if (done.length) console.log(`paystack reconcile ${user.email}: ${done.map((d) => `${d.reference} ${d.result}`).join(", ")}`);
    return json({ ok: true, checked: done.length, results: done });
  }

  const key = secretKey();
  const db = adminClient();
  const { enabled, channels, packages: shelf } = await packages();
  if (!enabled) {
    return fail("Online payment is not switched on yet. Please pay another way for now.", 503);
  }

  const method = chosenMethod(body.method, channels);
  if (!method) {
    return fail("Choose how you want to pay: card or mobile money.", 400);
  }

  const email = cleanEmail(body.email);
  if (!email) return fail("Type the email address your account was created with, properly.", 400);

  const planId = String(body.plan_id ?? "").trim();
  const plan = shelf.find((p: Record<string, unknown>) => p.id === planId);
  if (!plan) return fail("That package is not on sale right now.", 400);
  // The page lists every package the seller has, including one he has not finished
  // pricing or has not put minutes on. Those show on the page with the reason written
  // on the card; they cannot be paid for, and this is the door that says so.
  if (plan.buyable !== true || Number(plan.price_ghp) <= 0) {
    return fail("That package cannot be paid for online yet. Ask the seller before you buy it.", 400);
  }

  // The address has to belong to an account, or the money buys minutes for
  // nobody. Better to refuse before any money is taken than after.
  const { data: profile } = await db.from("profiles").select("id").ilike("email", email).maybeSingle();
  if (!profile) {
    return fail(
      `No Stream Live account uses ${email}. Create the account first, then come back and pay with the same address.`,
      404,
    );
  }

  // Someone hammering this button would otherwise pile up open orders. Orders the seller's
  // own clock has already let go are not counted, or a buyer who abandoned a checkout
  // half an hour ago would be punished for it.
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await db
    .from("payments")
    .select("id", { count: "exact", head: true })
    .eq("email", email)
    .eq("status", "pending")
    .is("expired_at", null)
    .gte("created_at", since);
  if ((count ?? 0) >= 5) return fail("Too many unfinished payments from this address. Try again shortly.", 429);

  const reference = newReference();
  const amount = Number(plan.price_ghp);
  const returnUrl = pageUrl();
  if (!returnUrl) return fail("The checkout page address is not configured on the server.", 500);

  const { data: order, error: insertError } = await db
    .from("payments")
    .insert({
      reference,
      email,
      user_id: profile.id,
      plan_id: plan.id,
      channel: method,
      amount,
      currency: "GHS",
      paystack_domain: integration(key),
      status: "pending",
    })
    .select("reference")
    .single();
  if (insertError) return fail(insertError.message, 500);

  const init = await paystack("/transaction/initialize", key, {
    email,
    amount,
    currency: "GHS",
    reference,
    // One door only: the buyer chose card or wallet, so Paystack's screen shows
    // nothing else. For mobile money the networks listed on that screen are the
    // ones switched on for this account, which is why no network is named here.
    channels: [method],
    callback_url: `${returnUrl}/?check=${reference}`,
    metadata: {
      custom_fields: [
        { display_name: "Package", variable_name: "plan_id", value: plan.id },
        { display_name: "Account", variable_name: "user_id", value: profile.id },
        { display_name: "Paid by", variable_name: "channel", value: method },
      ],
    },
  });

  const data = init.body?.status === true ? init.body.data : null;
  if (!data?.authorization_url) {
    const message = init.body?.message ?? "the payment provider did not answer";
    await db.from("payments").update({ status: "failed", note: message }).eq("reference", reference);
    console.error(`paystack initialize failed (${init.status}): ${message}`);
    return fail("The payment provider refused to open a checkout. Nothing was charged. Try again shortly.", 502);
  }

  await db.from("payments").update({ access_code: data.access_code ?? null }).eq("reference", reference);

  return json({ ok: true, reference, checkout_url: data.authorization_url, pay: String(plan.price_ghp / 100) });
}

Deno.serve((req) => (req.method === "OPTIONS" ? preflight() : handle(req).catch((e) => {
  console.error("paystack-checkout:", e?.message ?? e);
  return fail("The payment service had a problem. Nothing was charged.", 500);
})));
