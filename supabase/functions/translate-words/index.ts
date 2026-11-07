// POST translate-words
// Changes the WORDS a cloned voice is about to speak into the language the customer chose, and
// nothing else.
//
// The voice card on both cloning tabs has always spoken the caller's words back in the language they
// were said in, because that is what a voice does: it is handed text and reads it. A customer who
// wants his cloned voice answering in Spanish rather than in the language that came down the line has
// to have those WORDS changed first - and the voice service hands over no words, only audio and, from
// the reading step, the name of the language it heard. So this route is the step between them: the
// reading gives the words, this changes them, and the speaking is exactly the call it has always been,
// on the same voice with the same delivery figures.
//
// What it deliberately does not do:
//   * it never replaces a voice. The identity on the line is the one he picked, and a second model
//     re-voicing his caller is the thing his customers would hear first.
//   * it charges nothing. No minute is drawn, settled or looked at here; the call is already being
//     metered by the lease this route only checks. The translator's own allowance is the account
//     holder's business, not the customer's.
//   * it cannot be pointed at any address. One fixed vendor call, one fixed body shape, and the
//     language is read off a table rather than passed through - so this is not an open proxy, which
//     is the reason proxy-voice keeps its own allow-list too.
//   * it never makes a call go quiet. Whatever goes wrong here - no key linked, the translator slow,
//     the language one it does not serve - the answer is a plain refusal and the app speaks the words
//     as they came. A customer whose voice answers in the language he said them in got a working call;
//     a blank answer is not the price of a translation.
//
// Body: { sessionId, text, to }      Resp: { ok: true, text } | { error, reason }
import { preflight, json, fail } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { adminClient } from "../_shared/db.ts";

/** Deno's clock vs Postgres' now(): refuse a lease only past a small skew window. */
const LEASE_SKEW_MS = 10_000;

/**
 * How long to wait for the translator. It sits INSIDE the gap between his sentence and his cloned
 * voice answering, and that gap is the one figure this app has been judged on since the first call.
 * Anything slower than this is not worth waiting for: the words go out unchanged instead.
 */
const TRANSLATE_TIMEOUT_MS = 1500;

/** One sentence's worth of words, in characters. Longer than any real turn and shorter than a bill. */
const MAX_CHARS = 1200;

/**
 * The languages words may be changed INTO, keyed by the code the app sends. Two cards ask this route,
 * and they are held to different lists on purpose.
 *
 * The Answer in box changes the words his cloned voice is about to SPEAK, so every name on that row is
 * a name that already stands in the voice list he picks models from: a language no voice of his can
 * say is a choice that leads nowhere. Those are the first eleven below.
 *
 * The text box changes the words his CALLER said, which are only ever read on a screen - no voice is
 * involved, so the shelf does not decide what may be offered there. Those are the five after them, and
 * each code is what the TRANSLATOR calls that language, which is not always the same two letters.
 */
const TARGETS: Record<string, string> = {
  es: "ES", fr: "FR", de: "DE", zh: "ZH", it: "IT", pt: "PT-PT",
  ko: "KO", tr: "TR", no: "NB", hu: "HU", id: "ID",
  // Read on the screen only: nothing here has to be sayable by a voice on his shelf.
  pl: "PL", sv: "SV", ja: "JA", ar: "AR", nl: "NL",
};

/**
 * The same table for the side the words arrive on. The reading step names that language in its own
 * two letters and the translator uses its own, and the two agree on nearly everything - Norwegian is
 * the exception worth writing down, NO on the line and NB at the translator. A source the translator
 * does not recognise is a refusal on a sentence that was otherwise fine, so a code that is not in
 * this table goes unsent rather than guessed at, and the translator works the source out from the
 * words - which is what it is good at on a full sentence.
 */
const SOURCES: Record<string, string> = {
  en: "EN", es: "ES", fr: "FR", de: "DE", zh: "ZH", it: "IT", pt: "PT", ko: "KO",
  tr: "TR", no: "NB", hu: "HU", id: "ID", ja: "JA", nl: "NL", pl: "PL", ru: "RU",
  // A caller may speak either of these, and the reading step names them in its own two letters.
  ar: "AR", sv: "SV",
};

/**
 * A free translator key and a paid one live at different addresses, and the vendor's own page says
 * which is which twice over: "Use https://api.deepl.com for Pro plans and
 * https://api-free.deepl.com for the Free plan", and "DeepL API Free authentication keys can be
 * identified easily by the suffix ':fx'". Read the key rather than guessing, and ask the other
 * address before calling the key bad: a refusal from the wrong address looks exactly like a broken
 * account, which is the one mistake here that would cost a customer his voice for nothing.
 */
function apiHosts(key: string): string[] {
  const free = /:fx(?:free)?$/i.test(key);
  return free ? ["https://api-free.deepl.com", "https://api.deepl.com"]
    : ["https://api.deepl.com", "https://api-free.deepl.com"];
}

/**
 * The language the reading step named, looked up rather than passed through - see the table above.
 * Three-letter codes such as the one for Filipino answer as nothing at all, which is the useful
 * answer: no source named is a request the translator can still serve.
 */
function sourceLang(raw: unknown): string | undefined {
  const code = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return SOURCES[code];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return fail("method not allowed", 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return fail("nothing to translate", 400, { reason: "no_words" });
    if (text.length > MAX_CHARS) return fail("too many words at once", 400, { reason: "too_long" });

    const to = TARGETS[String(body.to ?? "").trim().toLowerCase()];
    if (!to) return fail("that language is not offered", 400, { reason: "no_language" });

    // Only a call that is really open may ask. This is the narrower version of the check proxy-voice
    // makes before it hands anything to the voice line: the lease has to be live, his, and carrying a
    // voice. It stops at that, on purpose - the cloning door governs whether a voice is SPEAKING, and
    // a call whose voice the administrator has just shut is refused there and never reaches this line
    // with anything left to say.
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!sessionId) return fail("sessionId is required", 400, { reason: "no_lease" });
    const db = adminClient();
    const { data: session } = await db
      .from("usage_sessions")
      .select("id, user_id, modality, ended_at, settled, lease_expires_at")
      .eq("id", sessionId)
      .maybeSingle();
    if (!session || session.user_id !== user.id) return fail("session not found", 404);
    if (session.ended_at || session.settled) return fail("session has ended", 403, { reason: "session_ended" });
    if (session.modality !== "audio" && session.modality !== "video_audio") {
      return fail("session does not include voice", 403, { reason: "modality_disabled" });
    }
    if (session.lease_expires_at && Date.parse(session.lease_expires_at) + LEASE_SKEW_MS < Date.now()) {
      return fail("the call stopped checking in and was closed", 403, { reason: "lease_expired" });
    }

    // The key is this function's own secret and never travels to the app, which is the same rule the
    // voice key follows. Without it the feature simply is not there: the answer goes out in the
    // language it was said in, and the card counts that as a sentence it did not change.
    const key = (Deno.env.get("DEEPL_KEY") ?? "").trim();
    if (!key) return fail("no translator is linked", 503, { reason: "no_translator" });

    const from = sourceLang(body.from);
    // ONE deadline for the whole hop, however many addresses it walks. The app gives up on these
    // words at 2.5 seconds and speaks the sentence as it heard it, so a second address must never
    // make a customer wait past the bound the first one was given.
    const deadline = Date.now() + TRANSLATE_TIMEOUT_MS;
    const hosts = apiHosts(key);
    let res: Response | null = null;
    let detail = "";
    for (let i = 0; i < hosts.length; i++) {
      try {
        res = await fetch(`${hosts[i]}/v2/translate`, {
          method: "POST",
          headers: {
            Authorization: `DeepL-Auth-Key ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: [text],
            target_lang: to,
            ...(from ? { source_lang: from } : {}),
          }),
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
      } catch (err) {
        // Too slow, or no answer at all. Not the customer's problem to hear about: the turn is spoken
        // in the language it arrived in, exactly as it was before this line existed.
        console.warn(`translate-words: ${err instanceof Error ? err.message : String(err)}`);
        return fail("the translator did not answer", 502, { reason: "translator_slow" });
      }
      if (res.ok) break;
      detail = await res.text().catch(() => "");
      // A 403 is the only answer that can mean the wrong address rather than a bad key, and the two
      // are told apart by what the body says: a spent allowance names characters, an unknown key does
      // not. So a spent allowance costs one request per sentence, not two, and a key held at the
      // wrong address - which is what the suffix rule above is for - is still served.
      if (res.status === 403 && i === 0 && !/character|quota/i.test(detail)) {
        console.warn(`translate-words: ${hosts[0]} does not know this key - asking ${hosts[1]}`);
        continue;
      }
      break;
    }
    if (!res) return fail("the translator did not answer", 502, { reason: "translator_slow" });

    if (!res.ok) {
      console.warn(`translate-words: HTTP ${res.status} ${detail.slice(0, 200)}`);
      // 403 is the allowance spent or the key refused; 400 is a pair it will not serve. Either way the
      // app does the same useful thing with the reason: speak the words it already has.
      return fail("the translator refused this one", res.status === 429 ? 429 : 502,
        { reason: res.status === 403 ? "translator_quota" : "translator_refused" });
    }

    const j = await res.json().catch(() => null) as
      { translations?: Array<{ text?: unknown }> } | null;
    const said = typeof j?.translations?.[0]?.text === "string" ? j.translations[0].text.trim() : "";
    if (!said) return fail("the translator gave back nothing", 502, { reason: "translator_empty" });

    return json({ ok: true, text: said });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unauthorized";
    const status = /authoriz|session|token/i.test(msg) ? 401 : 500;
    return fail(msg, status);
  }
});
