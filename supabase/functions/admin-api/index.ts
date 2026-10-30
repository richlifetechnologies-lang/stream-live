// POST admin-api
// The admin panel runs in a browser with the anon key + the admin's own JWT, so it
// cannot reach the service-role money RPCs directly. This function is that bridge:
// it proves the caller is an admin, then performs the one operation asked for.
//
// Body: { action: string, ... }
//   grant         { userId, modality, minutes, reason, unlimited? }
//   end_session   { sessionId }
//   resolve       { requestId, approve, note?, minutes? }
//   reap          { userId? }                 -- close expired leases
//   signout       { userId }                 -- kill every refresh token
//   delete_account{ userId, reason? }        -- remove the account for good
//   set_engine    { userId, engine: 'fal'|'decart'|null } -- pin/unpin the service
//   test_key      { provider, key? , keyId? } -- prove a key works, no inference billed
//   fal_balance   { }                   -- the account balance and today's spend, live from fal.ai
//   fal_balance_test { key }            -- ask fal.ai what one pasted billing key can see, save nothing
//   fal_balance_save { key?, label?, warnBelow?, alertBelow?, remove? }
//   paystack_reconcile { reference? }  -- ask Paystack about unpaid orders, credit what it confirms
//   calls              { }             -- the paid-call ledger, read unfiltered
//   paystack_webhook   { set? }        -- read the call-back address, or register this gateway's
// Resp: { ok:true, ...result } or { error, status }
import { preflight, json, fail } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { adminClient } from "../_shared/db.ts";
import { grantCredits, reapSessions, resolveRequest, signOutEverywhere, updateLease, type Modality } from "../_shared/credits.ts";
import { verifyKey, type Provider } from "../_shared/verify.ts";
import { normalizeSecret } from "../_shared/keys.ts";
import { falAccountBalance, falBalance, falKeyList, falKeyTail, forgetFalBalance } from "../_shared/fal-balance.ts";
import { reconcilePending, settleByReference, webhookRegister, webhookState } from "../_shared/paystack-reconcile.ts";

const MODALITIES = ["video", "audio", "video_audio"];

/** A dollar figure for a sentence the administrator reads, never for a machine. */
function money(value: number, currency: string): string {
  return `${currency === "USD" ? "$" : `${currency} `}${value.toFixed(2)}`;
}

async function requireAdmin(userId: string): Promise<boolean> {
  const { data } = await adminClient()
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();
  return data?.is_admin === true;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return fail("method not allowed", 405);

  try {
    const user = await requireUser(req);
    if (!(await requireAdmin(user.id))) return fail("admin only", 403);

    const body = await req.json().catch(() => ({}));
    const action = typeof body.action === "string" ? body.action : "";

    switch (action) {
      case "grant": {
        const modality = String(body.modality ?? "");
        const minutes = Number(body.minutes);
        if (!MODALITIES.includes(modality)) return fail("modality must be video, audio or video_audio");
        if (!Number.isFinite(minutes)) return fail("minutes must be a number");
        if (String(body.reason || "").trim().length < 3) return fail("a reason is required (audit trail)");
        const res = await grantCredits(
          String(body.userId),
          modality as Modality,
          minutes,
          String(body.reason),
          user.id,
          { unlimited: body.unlimited === true || body.unlimited === false ? body.unlimited : null },
        );
        // The RPC refuses a repeat of the same grant within a few seconds; say so
        // rather than reporting a success that changed nothing.
        if (res.ok !== true) return fail(String(res.error ?? "grant refused"), 409, { deduped: res.deduped === true });
        return json({ ok: true, ...res });
      }

      case "end_session": {
        const res = await updateLease(String(body.sessionId), "end");
        return json({ ok: res.ok, ...res });
      }

      case "resolve": {
        const res = await resolveRequest(
          String(body.requestId),
          body.approve === true,
          user.id,
          body.note ? String(body.note) : undefined,
          body.minutes !== undefined && body.minutes !== null ? Number(body.minutes) : undefined,
        );
        return json({ ok: true, ...res });
      }

      case "reap": {
        const closed = await reapSessions(body.userId ? String(body.userId) : undefined);
        return json({ ok: true, closed });
      }

      case "signout": {
        const target = String(body.userId);
        const sessions = await signOutEverywhere(target);
        // Also close anything still leasing so the minute counter stops.
        const closed = await reapSessions(target);
        return json({ ok: true, sessions, closed });
      }

      // body.engine: "fal" | "decart" | null | "auto" — the last two clear the pin
      // and put the account back under the normal rule.
      case "set_engine": {
        const target = String(body.userId ?? "");
        if (!target) return fail("userId is required");
        const wanted = body.engine === "decart" || body.engine === "fal"
          ? body.engine
          : body.engine === null || body.engine === "auto" || body.engine === "" ? null : undefined;
        if (wanted === undefined) return fail("engine must be fal, decart, or null for automatic");
        // The one-way door is the database's rule, not this function's, so the
        // refusal wording an admin sees is exactly what the RPC decided.
        const { data, error } = await adminClient().rpc("sl_set_engine_override", {
          p_user: target, p_engine: wanted, p_actor: user.id,
        });
        if (error) return fail(error.message, 500);
        const out = (data ?? {}) as { ok?: boolean; error?: string; engine_override?: string | null; effective?: string };
        if (out.ok !== true) return fail(String(out.error ?? "refused"), 409);
        return json({ ok: true, engine_override: out.engine_override ?? null, effective: out.effective ?? "automatic" });
      }

      case "trial_supply": {
        // The gateway's own arithmetic on the Decart pool, run by the gateway's
        // role — the panel must not re-derive it from the budget columns and be
        // subtly wrong about how much free video is left.
        const { data, error } = await adminClient().rpc("sl_trial_supply");
        if (error) return fail(error.message, 500);
        return json({ ok: true, ...(data ?? {}) });
      }

      // Remove an account and everything hanging off it: sign-in, devices, buckets,
      // history. Every app table cascades from profiles(id), so deleting the auth user
      // sweeps the account clean by itself — which is why a witness row is written to
      // account_deletions first. Administrators cannot be deleted; that also makes
      // self-deletion impossible, since only an administrator reaches this code.
      case "delete_account": {
        const target = String(body.userId ?? "");
        if (!target) return fail("userId is required");
        const db = adminClient();
        const { data: prof } = await db
          .from("profiles")
          .select("id, email, created_at, is_admin")
          .eq("id", target)
          .maybeSingle();
        if (!prof) return fail("no such account", 404);
        if (prof.is_admin) return fail("That account is an administrator. Clear its admin flag first if it really should go.", 409);

        const { data: buckets } = await db
          .from("credit_balances")
          .select("modality, balance, unlimited, total_credited")
          .eq("user_id", target);
        const balances: Record<string, number | string> = {};
        for (const m of MODALITIES) {
          const b = (buckets ?? []).find((x) => x.modality === m);
          balances[m] = b?.unlimited === true ? "unlimited" : Number(b?.balance ?? 0);
        }

        // Close a live lease before the row disappears. Ending it is what hands the
        // unused prepaid window back to the trial key; deleting the session outright
        // would leave that key's budget short for good.
        const { data: open } = await db
          .from("usage_sessions")
          .select("id")
          .eq("user_id", target)
          .is("ended_at", null);
        for (const s of open ?? []) {
          try { await updateLease(String(s.id), "end"); } catch { /**/ }
        }

        const { error: logErr } = await db.from("account_deletions").insert({
          actor_id: user.id,
          actor_email: user.email ?? null,
          user_id: target,
          email: prof.email ?? null,
          created_at: prof.created_at ?? null,
          balances,
          minutes: (buckets ?? []).reduce((a, b) => a + Number(b.total_credited ?? 0), 0),
          reason: body.reason ? String(body.reason) : null,
        });
        // The record is the only trace left, so a failure to write it stops the delete.
        if (logErr) return fail(`refused: the deletion could not be recorded (${logErr.message}). Apply the migrations, then try again.`, 500);

        const { error } = await db.auth.admin.deleteUser(target);
        if (error) return fail(error.message, 500);
        return json({ ok: true, email: prof.email ?? null });
      }

      case "test_key": {
        const provider = body.provider === "elevenlabs" ? "elevenlabs"
          : body.provider === "fal" ? "fal"
            : body.provider === "decart" ? "decart" : null;
        if (!provider) return fail("provider must be fal, elevenlabs or decart");
        const keyId = typeof body.keyId === "string" && body.keyId ? body.keyId : null;
        let secret = typeof body.key === "string" ? body.key : "";
        if (!secret.trim() && keyId) {
          const column = provider === "fal" ? "fal_key" : provider === "decart" ? "decart_key" : "elevenlabs_key";
          const { data } = await adminClient().from("gateway_keys").select(column).eq("id", keyId).maybeSingle();
          secret = String((data as Record<string, string | null> | null)?.[column] ?? "");
        }
        if (!secret.trim()) return fail("Nothing to test — paste a key, or save it first and verify the stored copy.");
        const res = await verifyKey(provider as Provider, secret);
        // Logged, but deliberately not through sl_report_key_use: a manual check
        // says nothing about this key's daily burn and must not clear a real
        // last_error that a live call recorded.
        if (keyId) {
          await adminClient().from("key_usage_log").insert({
            key_id: keyId,
            provider,
            user_id: null,
            outcome: res.ok ? "ok" : "fail",
            status: res.status,
            detail: `verify: ${res.detail}`,
          });
        }
        return json({ ok: true, provider, verified: res.ok, status: res.status, detail: res.detail });
      }

      // ── The money side: what is left to spend on calls ────────────────────────
      // Read-only, and the reading is the important half: fal reports the balance for
      // the whole account, so one stored billing key answers for every pool key. The
      // per-key figures ride along in the same payload because the panel paints its
      // key table from it and a second request would show a different instant.
      //
      // ok:true means this function did its job. Whether fal answered is a separate
      // matter the card reads off balance/detail, so a fal outage must not arrive as
      // a thrown request — "the balance could not be read" is a picture, not an error.
      case "fal_balance":
        return json({ ...(await falBalance()), ok: true });

      // { key }  -- what does this key see? Saves nothing, spends nothing. A blank key
      // re-checks the stored one, which is what the pool's Verify button means.
      case "fal_balance_test": {
        let key = normalizeSecret(String(body.key ?? ""));
        if (!key) {
          const { data } = await adminClient().from("fal_watch").select("billing_key").limit(1).maybeSingle();
          key = normalizeSecret(String(data?.billing_key ?? ""));
        }
        if (!key) return fail("Paste a key first — there is no stored billing key to check either.");
        const bal = await falAccountBalance(key);
        if ("err" in bal) return json({ ok: true, verified: false, detail: bal.err });
        const list = await falKeyList(key);
        const mine = "err" in list ? null : list.keys.find((k) => k.id === key.split(":")[0]);
        // BILLING and READONLY presets cannot open an inference call, which is what
        // makes them safe to keep in a table the panel reads. Anything else can.
        const spendable = mine ? !/^(BILLING|READONLY)$/.test(mine.preset) : null;
        return json({
          ok: true,
          verified: true,
          balance: bal.balance,
          currency: bal.currency,
          tail: falKeyTail(key),
          preset: mine?.preset ?? "unknown to fal's key list",
          spendable,
          detail: `This key reads ${money(bal.balance, bal.currency)} on the account.`
            + (spendable === false ? " It cannot start a call, so it is the right kind to store."
              : spendable === true ? " Caution: it CAN start calls and spend money. A BILLING-preset key reads the same balance without that risk."
                : ""),
        });
      }

      // { key?, label?, warnBelow?, alertBelow?, remove? }  -- write the stored key
      // Blank key keeps what is already there, so editing the amounts never needs the
      // secret again. A pasted key is proven against fal BEFORE it is saved: a typo
      // kept silently would leave the card showing yesterday's number forever.
      case "fal_balance_save": {
        const db = adminClient();
        const { data: existing } = await db.from("fal_watch").select("id").limit(1).maybeSingle();

        if (body.remove === true) {
          if (!existing) return fail("There is no billing key stored, so there is nothing to forget.");
          const { error } = await db.from("fal_watch").delete().eq("id", existing.id);
          if (error) return fail(`could not forget the key: ${error.message}`);
          forgetFalBalance();
          return json({ ok: true, removed: true });
        }

        const amount = (v: unknown): number | null => {
          if (v === null || v === undefined || String(v).trim() === "") return null;
          const n = Number(v);
          return Number.isFinite(n) && n >= 0 ? n : NaN;
        };
        const warn = amount(body.warnBelow), alert = amount(body.alertBelow);
        if (Number.isNaN(warn)) return fail("the amber amount has to be a number of dollars, or blank for no colour");
        if (Number.isNaN(alert)) return fail("the red amount has to be a number of dollars, or blank for no colour");
        if (warn !== null && alert !== null && alert > warn) {
          return fail("red has to be the smaller amount: red means running out, amber means nearly there");
        }

        let secret = normalizeSecret(String(body.key ?? ""));
        if (!secret && existing) {
          const { data } = await db.from("fal_watch").select("billing_key").eq("id", existing.id).maybeSingle();
          secret = normalizeSecret(String(data?.billing_key ?? ""));
        }
        if (!secret) {
          return fail("Nothing to save — paste a fal.ai billing key, or leave it blank and change the amounts on the stored one.");
        }
        const bal = await falAccountBalance(secret);
        if ("err" in bal) return json({ ok: true, saved: false, verified: false, detail: `${bal.err}. Nothing was saved.` });

        const list = await falKeyList(secret);
        const mine = "err" in list ? null : list.keys.find((k) => k.id === secret.split(":")[0]);
        const spendable = mine ? !/^(BILLING|READONLY)$/.test(mine.preset) : null;

        const label = typeof body.label === "string" && body.label.trim()
          ? body.label.trim().slice(0, 60)
          : "fal balance key";
        const row = { label, billing_key: secret, warn_below: warn, alert_below: alert, updated_at: new Date().toISOString() };
        const { error } = existing
          ? await db.from("fal_watch").update(row).eq("id", existing.id)
          : await db.from("fal_watch").insert(row);
        if (error) return fail(`could not save: ${error.message}`);
        forgetFalBalance();
        return json({ ...(await falBalance()), ok: true, saved: true, verified: true, tail: falKeyTail(secret), preset: mine?.preset ?? "", spendable });
      }

      // ── Online payments: ask Paystack, and make it tell us next time ──────────
      // { reference? }  -- one order, or everything on the waiting list
      // The list is what a stuck payment needs when the seller's Paystack call-back
      // box was never filled in: this asks Paystack directly and credits from the
      // answer. A named reference is asked even if it was asked about a moment ago,
      // because the person pressing the button is looking at that one line.
      case "paystack_reconcile": {
        const reference = typeof body.reference === "string" ? body.reference.trim() : "";
        if (reference) {
          if (!/^[A-Za-z0-9_.-]{6,64}$/.test(reference)) return fail("that reference is not one of ours");
          return json({ ok: true, results: [await settleByReference(reference)] });
        }
        const results = await reconcilePending(null, 25);
        return json({ ok: true, results, nothing_to_ask: results.length === 0 });
      }

      // { set?: true }  -- read the call-back address Paystack has, or give it ours
      // Setting it is deliberately a separate press: it overwrites whatever is in that
      // box on his account, which is somebody else's integration if he ever shares one.
      case "paystack_webhook": {
        if (body.set === true) {
          const url = `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "")}/functions/v1/paystack-webhook`;
          if (!url.startsWith("https://")) return fail("this server does not know its own address, so it cannot register a call-back");
          const res = await webhookRegister(url);
          return json({ ok: res.ok, set: true, url, detail: res.detail });
        }
        const state = await webhookState();
        return json({ ok: true, url: state.url, detail: state.detail });
      }

      // { }  -- the paid-call ledger, every figure that card shows, in one ask.
      // The panel used to read these tables itself with the admin's own JWT, and a
      // security policy that filters him out answers an empty list with no error at
      // all: a card that reads "no calls have happened" while calls are happening.
      // The gateway's own role is not filtered, so the money side comes through here.
      case "calls": {
        const db = adminClient();
        const reads = await Promise.all([
          db.from("usage_sessions")
            .select("id, user_id, started_at, media_started_at, ended_at, lease_expires_at, billed_minutes, pending_debit, multiplier, settled")
            .eq("engine", "fal").order("started_at", { ascending: false }).limit(60),
          db.from("usage_sessions").select("id", { count: "exact", head: true }).eq("engine", "fal"),
          db.from("usage_sessions").select("id", { count: "exact", head: true }).eq("engine", "decart"),
          db.from("usage_sessions").select("id", { count: "exact", head: true }),
          db.from("billing_config").select("lucy_video_per_sec_cost").eq("id", 1).maybeSingle(),
          db.from("app_config").select("paystack_ghs_per_usd").eq("id", 1).maybeSingle(),
          db.from("plans").select("id, name, active, monthly_minutes, video_minutes, price_cents, price_ghp"),
          db.from("subscriptions").select("user_id, plan_id"),
          db.from("payments").select("user_id").in("status", ["paid", "credited"]),
        ]);
        const failed = reads.find((r) => r.error)?.error;
        if (failed) return fail(`the call ledger could not be read: ${failed.message}`);
        const [rows, falCount, trialCount, allCount, cfg, ac, plans, subs, paid] = reads;
        const ids = [...new Set((rows.data || []).map((r) => r.user_id).filter(Boolean))];
        const names = ids.length ? await db.from("profiles").select("id, email").in("id", ids) : { data: [] };
        return json({
          ok: true,
          rows: rows.data || [],
          names: names.data || [],
          paidUsers: (paid.data || []).map((p) => p.user_id),
          perSecond: cfg.data?.lucy_video_per_sec_cost ?? null,
          fx: ac.data?.paystack_ghs_per_usd ?? null,
          plans: plans.data || [],
          subs: subs.data || [],
          falRows: falCount.count ?? 0,
          trialRows: trialCount.count ?? 0,
          allRows: allCount.count ?? 0,
        });
      }

      default:
        return fail(`unknown action: ${action || "(none)"}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unauthorized";
    const status = /authoriz|session|token/i.test(msg) ? 401 : 500;
    return fail(msg, status);
  }
});
