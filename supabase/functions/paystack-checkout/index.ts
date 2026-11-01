// paystack-checkout — the buyer's door to an online payment.
//
//   GET  /                       -> the packages on sale and how they can be paid for
//   GET  /?market=intl           -> the international shelf instead of the home one
//   GET  /?check=<reference>     -> how that one payment is doing, asked of Paystack itself
//   POST / { email, plan_id, method } -> opens the payment, returns Paystack's page
//   POST / { reconcile: true }   -> with the app's own sign-in: settle every order that
//                                   address has paid for and not been credited for
//
// Two shelves, one door each. `market` is which list the customer chose for himself by
// tapping it in the app — the Ghana shelf, paid in cedis by mobile money, or the
// international one, paid by card — and it is NEVER read off the address the request came
// from. A Ghanaian on a VPN and a foreign visitor in Accra both get the shelf they
// themselves picked, and the price on it is the seller's, not a machine's guess. The till
// can also say which door it wants with `?way=card` / `?way=mobile_money`, which is what the
// app already sends; either word lands on the same shelf.
//
// A request that names NEITHER word is the till as it existed before there were two shelves —
// a bookmarked page, an app build that has not updated — and it is served the same answer it
// always got: the home list and both of the seller's open doors. Nothing already in a
// customer's hands loses the ability to pay because a rule arrived that it was never built to
// speak.
//
// Where a shelf IS named, the door is enforced here, on the server:
// plans.market says whether that package is a Ghana one or an international one, and the
// channel that does not belong to its shelf is refused before Paystack is asked for a
// checkout. A page that was bookmarked, half-loaded or hand-typed cannot open a door the
// shelf does not have.
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

/** The two shelves, and nothing else. */
type Market = "gh" | "intl";

/**
 * `both` is not a shelf: it is a till that has no shelf on its address — a page somebody
 * bookmarked before the split, or an app build that has not updated. It is answered exactly as
 * it was answered before, with the seller's own channel switches and the home list, so nothing
 * that is already in a customer's hands stops taking money the day this ships.
 */
type Shelf = Market | "both";

/** The one payment method each shelf takes money through. */
const SHELF_DOOR: Record<Market, "card" | "mobile_money"> = { gh: "mobile_money", intl: "card" };

/**
 * Which shelf a request is for, from what the customer himself chose. `?market=` is the
 * honest word; `?way=` is the one the app already puts on the till's address, and it can
 * only ever mean one shelf. Neither word means the old, shelf-less question. No address, no
 * header, no country is looked at here.
 */
function shelfFor(params: URLSearchParams): Shelf {
  const m = (params.get("market") || "").trim().toLowerCase();
  if (m === "intl" || m === "gh") return m;
  const w = (params.get("way") || "").trim().toLowerCase();
  if (w === "card") return "intl";
  if (w === "mobile_money") return "gh";
  return "both";
}

/**
 * The same reading on a POST body. Null means the page never said which list it was standing
 * on, and then no door is enforced — the seller's own switches decide, as they always did.
 */
function shelfFromBody(body: Record<string, unknown>): Market | null {
  const m = String(body.market ?? "").trim().toLowerCase();
  if (m === "intl" || m === "gh") return m;
  const w = String(body.way ?? "").trim().toLowerCase();
  return w === "card" ? "intl" : w === "mobile_money" ? "gh" : null;
}

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

/**
 * The two-letter country the platform put on this request, when it puts one at all. Proved on
 * this project on 2026-10-31 that this runtime is NOT handed `cf-ipcountry` - the probe
 * received `cf-connecting-ip`, `cf-ray` and `x-forwarded-for` but no country - so this is the
 * cheap first try and the address lookup below is what actually fills a flag.
 */
function requestCountry(req: Request): string | null {
  const raw = (req.headers.get("cf-ipcountry") ?? "").trim();
  return /^[A-Za-z][A-Za-z]$/.test(raw) ? raw : null;
}

/**
 * The address the platform saw this request come from, and it is a real one here: the probe
 * showed `cf-connecting-ip` equal to the caller's own public address, with the same address
 * first in `x-forwarded-for`. Only an entry shaped like a bare address is taken.
 */
function requestIp(req: Request): string {
  const raw = req.headers.get("cf-connecting-ip")
    || req.headers.get("x-forwarded-for")
    || req.headers.get("sb-forwarded-for")
    || "";
  const first = raw.split(",")[0].trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(first) ? first : "";
}

/** Loopback, private, carrier-NAT, link-local and multicast addresses are never sent anywhere. */
function isPublicIp(ip: string): boolean {
  if (/^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return true;
  }
  // IPv6: only global unicast (2000::/3) is worth asking about, so a link-local or loopback
  // answer is never put on the wire.
  const hextet = ip.split(":")[0] ?? "";
  return ip.includes(":") && /^[23][0-9a-fA-F]{0,3}$/.test(hextet);
}

/**
 * The country behind an address, from one free look-up service, display only.
 *
 * This is the only part of the flag that costs anything or reaches a third party, so its
 * limits are narrow and they are enforced here: it runs only when the platform gave no
 * country, only for an account that has no flag yet, only for a public address, at most once
 * per account per app boot, and with a short timeout. A timeout, an error or an answer that
 * is not two letters all mean "no flag", which is what the panel already says out loud rather
 * than a guess. Nothing that costs the buyer money is ever read from it - no price, shelf,
 * door or amount.
 */
async function countryOfAddress(ip: string): Promise<string | null> {
  const res = await fetch("https://ipwho.is/" + ip, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || body.success !== true) return null;
  const cc = String(body.country_code ?? "").trim().toUpperCase();
  return /^[A-Z][A-Z]$/.test(cc) ? cc : null;
}

/**
 * Put a flag beside this account, and never get in the way of the payment check that the
 * caller actually came for - so every failure here is swallowed by the caller.
 */
async function noteCountry(req: Request, userId: string): Promise<void> {
  let cc = requestCountry(req);
  if (!cc) {
    const db = adminClient();
    const { data } = await db
      .from("profiles")
      .select("country, network_last_ip")
      .eq("id", userId)
      .maybeSingle();
    // An account already carrying a flag is left exactly as it is: that value came from his
    // own Ghana tap or from the seller, and the rule "only the first reading wins" is the
    // database's, not something to re-litigate on every boot.
    if (data?.country) return;
    const ip = requestIp(req) || String(data?.network_last_ip ?? "");
    if (isPublicIp(ip)) cc = await countryOfAddress(ip);
  }
  if (!cc) return;
  const { error } = await adminClient().rpc("sl_note_network", { p_user: userId, p_ip: null, p_country: cc });
  if (error) console.error("country stamp:", error.message);
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
 * One shelf: what the seller lists on it, the figure it is charged at, and the door it takes
 * money through. The page never has to be edited when he adds or re-prices a package —
 * sl_paystack_packages reads the same table the app's Plans screen does, and it is the shelf,
 * not the request, that names the door. An empty door list is passed through as it stands:
 * a seller who switched that method off on his own panel meant it, and this server will not
 * quietly hand his customers the other one instead.
 *
 * `both` is the shelf-less question, and it is answered the way it was answered before the
 * two lists existed — the home catalogue and whichever doors the seller has open. A bookmarked
 * till page and an app that has not updated are the only things that ask it, and neither may
 * find the door it has always used bricked.
 */
async function packages(shelf: Shelf = "both", lang: string | null = null) {
  const { data, error } = await adminClient().rpc("sl_paystack_packages", {
    p_market: shelf,
    p_lang: lang ?? null,
  });
  if (error) throw new Error(error.message);
  const rows = (data?.packages ?? []) as Array<Record<string, unknown>>;
  const open = Array.isArray(data?.channels)
    ? data.channels.filter((c: unknown) => c === "card" || c === "mobile_money")
    : [];
  return {
    enabled: data?.enabled === true,
    market: String(data?.market ?? shelf),
    // Which money the buyer's card is printed in: dollars abroad, cedis at home. The figure
    // taken is the cedi one on both shelves — payments.currency allows nothing else, and
    // Paystack refuses USD for this account.
    price_shows: String(data?.price_shows ?? "GHS"),
    currency: String(data?.currency ?? "GHS"),
    rate: Number(data?.ghs_per_usd ?? 12),
    page: pageUrl(),
    channels: shelf === "both" ? open : open.filter((c: string) => c === SHELF_DOOR[shelf]),
    packages: rows,
  };
}

/** The buyer's choice of how to pay, or null when it is not one of the two open doors. */
function chosenMethod(raw: unknown, open: string[]): "card" | "mobile_money" | null {
  const m = String(raw ?? "").trim().toLowerCase();
  if (m !== "card" && m !== "mobile_money") return null;
  return open.includes(m) ? m : null;
}

/**
 * Which shelf a package belongs to, read off the package itself. This is the whole of the
 * payment-door rule, and it does not care what the page was shown or what the buyer meant:
 * a Ghana package is paid on mobile money and an international one by card, because that is
 * what the seller's two shelves say. A package this table does not know has no shelf, and the
 * order is refused further down for want of a package rather than for want of an address.
 */
async function shelfOfPlan(db: ReturnType<typeof adminClient>, planId: string): Promise<Market | null> {
  if (!planId) return null;
  const { data, error } = await db.from("plans").select("id, market").eq("id", planId).maybeSingle();
  if (error || !data?.id) return null;
  return data.market === "intl" ? "intl" : "gh";
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
    return json(await packages(shelfFor(url.searchParams), url.searchParams.get("lang")));
  }

  if (req.method !== "POST") return fail("use GET for the package list, POST to pay", 405);

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail("send a JSON body", 400);

  // The app asks for its own customer's stuck payments. Whoever calls this has already
  // proved who they are, so the answer is limited to orders paid for under that same
  // address — nobody can use it to poke at somebody else's money.
  if (body.reconcile === true) {
    const user = await requireUser(req);
    // The flag beside his account. This is the one gateway call a signed-in customer's app
    // makes just by being opened, so it records a country for everybody - not only for the few
    // who go on to start a call, and not only for those who update their app. The address is
    // deliberately left for the call door to record: this is the payment door, and the country
    // here is only ever a display reading. Bookkeeping never gets to refuse a payment check,
    // so any failure at all is swallowed and the check runs.
    try {
      await noteCountry(req, user.id);
    } catch {
      // Bookkeeping, not money.
    }
    if (!user.email) return fail("this sign-in has no email address to check payments against", 403);
    const done = await reconcilePending(user.email, 10);
    if (done.length) console.log(`paystack reconcile ${user.email}: ${done.map((d) => `${d.reference} ${d.result}`).join(", ")}`);
    return json({ ok: true, checked: done.length, results: done });
  }

  const key = secretKey();
  const db = adminClient();

  // The shelf comes from the package, and from the list the buyer was actually looking at when
  // the page says so. Asked first, because it says which door this order may go through — what
  // he typed into the method box is a thing a browser decides.
  const planId = String(body.plan_id ?? "").trim();
  const tapped = shelfFromBody(body);
  const own = await shelfOfPlan(db, planId);
  // A Ghana package standing in for its own abroad row is bought abroad, by card: the row's own
  // market would send that buyer to a mobile-money prompt he cannot answer.
  const market = tapped ?? own;
  const { enabled, channels, packages: shelf } = await packages(market ?? "both");
  if (!enabled) {
    return fail("Online payment is not switched on yet. Please pay another way for now.", 503);
  }

  // The door of the shelf he named, enforced here on the server before Paystack is asked for a
  // checkout: mobile money is a Ghana thing and a card abroad is a card thing, and no page —
  // stale, bookmarked, or written by hand in a console — can put the wrong one on a package.
  // A page that names no shelf at all is the old till, and it is not refused for a rule it
  // was never built to: its buyer pays through whichever door the seller has open.
  if (tapped && String(body.method ?? "").trim().toLowerCase() !== SHELF_DOOR[tapped]) {
    return fail(
      tapped === "intl"
        ? "That package is paid by card. Mobile money is only for packages bought in Ghana."
        : "That package is paid by mobile money. Choose mobile money and try again.",
      400,
    );
  }

  const method = chosenMethod(body.method, channels);
  if (!method) {
    return fail("Choose how you want to pay: card or mobile money.", 400);
  }

  const email = cleanEmail(body.email);
  if (!email) return fail("Type the email address your account was created with, properly.", 400);

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

  // He has now paid for a shelf, which is the clearest tap there is. Remembered against his
  // account so the next machine he signs in on opens on the same list — and it is only a
  // memory: the door above came from the package, and this cannot change anybody's price.
  // Bookkeeping never gets to refuse a payment, so a failure here is swallowed on purpose.
  try {
    await db.rpc("sl_note_market", {
      p_user: profile.id,
      p_market: market,
      p_source: "tap",
      p_country: null,
    });
  } catch {
    /* the order matters, the stamp does not */
  }

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
