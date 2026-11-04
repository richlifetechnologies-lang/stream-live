// POST account-language
// "What language does this account's own country suggest?"
//
// The panel has shown the seller a country beside an account since the flag went in, but the
// reading was only ever taken when the customer pressed Start or opened the payment page. A
// customer who signs in on a fresh machine has therefore never been asked, and his app opens in
// whatever Windows speaks. This route is that question, asked at sign-in: it reads the address the
// platform saw, fills the account's flag only if it has none, and answers with the language the
// country suggests.
//
// What it deliberately does not do:
//   * it trusts nothing the app sends. The body is empty; the address comes from the headers.
//   * it never overwrites a country. The database keeps only the first reading, so the customer's
//     own Ghana tap and the seller's word both survive exactly as they do today.
//   * it decides nothing about money. No price, shelf, package, payment door, wallet or engine is
//     read from the country — the flag's own column comment says so and this function agrees.
//   * it does not force the app's language. It only suggests. The desktop side keeps this answer
//     out of the way the moment the customer has used the language button himself, and his choice
//     is never taken back.
//
// Body: {}     Resp: { ok: true, country: "ES" | null, lang: "en"|"es"|"pt"|"fr"|"ar" | null }
// A failure of the look-up is not an error to the app: it answers with nulls and the app leaves the
// language exactly where it is.
import { preflight, json } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { adminClient } from "../_shared/db.ts";
import { countryForCaller } from "../_shared/geo.ts";

const LANGS = ["en", "es", "pt", "fr", "ar"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();

  let userId = "";
  try {
    userId = (await requireUser(req)).id;
  } catch {
    return json({ ok: false, country: null, lang: null, error: "sign in first" }, { status: 401 });
  }

  const db = adminClient();
  let country: string | null = null;
  try {
    country = await countryForCaller(req, userId, db);
  } catch (err) {
    console.error("account-language read:", err instanceof Error ? err.message : String(err));
  }

  // Stamp the flag only when there was a flag to stamp and the account had none — and never let
  // that write decide the answer, because the whole route is allowed to end in "no suggestion".
  if (country) {
    try {
      const { error } = await db.rpc("sl_note_network", { p_user: userId, p_ip: null, p_country: country });
      if (error) console.error("account-language stamp:", error.message);
    } catch { /* the flag can wait for his next call */ }
  }

  let lang: string | null = null;
  if (country) {
    try {
      const { data } = await db.rpc("sl_lang_for_country", { p_country: country });
      const got = String(data ?? "").trim().toLowerCase();
      lang = LANGS.includes(got) ? got : "en";
    } catch (err) {
      console.error("account-language mapping:", err instanceof Error ? err.message : String(err));
    }
  }

  return json({ ok: true, country, lang });
});
