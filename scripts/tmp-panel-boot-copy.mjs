// Disposable: make a bootable COPY of the built admin panel (admin-panel/index.html — the file that
// is actually published) whose network layer is stubbed, so the real page code can be rendered in a
// real browser with no login and no token. Nothing in the page's own logic is touched: only the
// supabase-js CDN tag is replaced and fetch is answered locally.
import fs from "node:fs";

const HERE = "C:/Users/david/Documents/Qoder/2026-10-30/19734475";
const panel = fs.readFileSync("admin-panel/index.html", "utf8");

// SC picks which last-24-hours blank picture reading the stub hands the card, so every branch of
// the new line is rendered rather than reasoned about: "none" = the count could not be taken,
// "zero" = a quiet day, and the default = the spike that motivated the line.
const SC = process.env.SC || "";
const BLANK = SC === "none" ? null : SC === "zero"
  ? { calls: 0, machines: 0, accounts: 0, worst: [], causes: null }
  : { calls: 5, machines: 2, accounts: 2,
      worst: [
        { machine: "3f9a2b7c11d4", calls: 4, seconds: 16.8, who: "davidallenmorrow9@gmail.com" },
        { machine: "b71c0d0a99ee", calls: 1, seconds: 4.6, who: "lilylife238@gmail.com" },
      ],
      causes: SC === "uncaused" ? null : { his_side: 3, our_side: 1 } };

const PAST = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const FUTURE = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
// The server, 721 minutes behind this machine - the gap in his screenshot.
const SERVER_ISO = new Date(Date.now() - 721 * 60000).toISOString();

// Four paid calls, one of each kind, plus one that never delivered anything. The figures below
// are the ones the proof checks: a picture call costs 600 s x $0.0035, a picture-and-voice call
// costs 600 s of picture + 600 s of voice, and a voice-only call costs the voice alone - never a
// picture it was never meant to send.
const START = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
const ENDED = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
const FRAME = new Date(Date.now() - 2 * 3600 * 1000 - 30 * 1000).toISOString();
const CALLS = {
  rows: [
    { id: "s1", user_id: "u-1", modality: "video", started_at: START, media_started_at: FRAME, ended_at: ENDED, lease_expires_at: ENDED, billed_minutes: 10, pending_debit: 0, multiplier: "1.000", settled: true },
    { id: "s2", user_id: "u-1", modality: "video_audio", started_at: START, media_started_at: FRAME, ended_at: ENDED, lease_expires_at: ENDED, billed_minutes: 15, pending_debit: 0, multiplier: "1.500", settled: true },
    { id: "s3", user_id: "u-1", modality: "audio", started_at: START, media_started_at: FRAME, ended_at: ENDED, lease_expires_at: ENDED, billed_minutes: 5, pending_debit: 0, multiplier: "0.500", settled: true },
    { id: "s4", user_id: "u-1", modality: "audio", started_at: START, media_started_at: null, ended_at: ENDED, lease_expires_at: ENDED, billed_minutes: 0, pending_debit: 0, multiplier: "0.500", settled: true },
  ],
  names: [{ id: "u-1", email: "lilylife238@gmail.com" }],
  paidUsers: ["u-1"],
  perSecond: 0.0035,
  voicePerSecond: 0.0007,
  fx: 15.5,
  plans: [{ id: "p1", name: "30 minutes", active: true, monthly_minutes: 30, video_minutes: 30, price_cents: 2000, price_ghp: 0 }],
  subs: [{ user_id: "u-1", plan_id: "p1" }],
  falRows: 4, trialRows: 2, allRows: 6,
  kindRows: { video: 1, audio: 2, video_audio: 1 },
};

const DATA = {
  profiles: [
    { id: "u-admin", email: "owner@proof.local", is_admin: true, created_at: PAST, country: "Ghana", name: "owner" },
    { id: "u-1", email: "lilylife238@gmail.com", is_admin: false, created_at: PAST, country: "Ghana", name: "lily" },
  ],
  subscriptions: [
    { user_id: "u-1", email: "lilylife238@gmail.com", status: "active", plan_id: null, video_enabled: true, audio_enabled: true, video_audio_enabled: true, cloning_mode: "voice_video", max_concurrent_sessions: 1, engine_override: null, trial_granted_at: null, created_at: PAST, updated_at: PAST },
    { user_id: "u-admin", status: "active", plan_id: null, video_enabled: true, video_audio_enabled: true, cloning_mode: "voice_video", max_concurrent_sessions: 1, trial_granted_at: null },
  ],
  credit_balances: [
    { user_id: "u-1", modality: "video", balance: "20.0", unlimited: false, total_credited: "30.0", total_spent: "10.0" },
  ],
  credit_ledger: [
    { id: 1, user_id: "u-1", modality: "video", minutes: 30, balance: 20, reason: "top up by hand", kind: "credit", created_at: PAST },
  ],
  burn_rates: [
    { id: 1, modality: "video", multiplier: "1.000", effective_from: PAST, retired_at: null, note: "seeded", created_by: null },
    { id: 2, modality: "video", multiplier: "1.250", effective_from: FUTURE, retired_at: null, note: "the rate he typed", created_by: null },
    { id: 3, modality: "audio", multiplier: "0.500", effective_from: PAST, retired_at: null, note: null, created_by: null },
    { id: 4, modality: "video_audio", multiplier: "1.500", effective_from: PAST, retired_at: null, note: null, created_by: null },
    { id: 5, modality: "video", multiplier: "1.200", effective_from: PAST, retired_at: PAST, note: "retired last week", created_by: null },
  ],
  app_config: [
    { id: 1, min_supported_version: "1.8.0", latest_version: "1.8.26", lease_chunk_minutes: 5, lease_ttl_seconds: 120, signup_enabled: true, maintenance: false, maintenance_message: "", cloning_mode: "voice_video", cloning_enabled: true, trial_enabled: true, trial_video_minutes: 3, max_concurrent_trial_sessions: 2, allow_fal_when_no_decart: true, max_concurrent_video_sessions: 0, support_email: "help@proof.local" },
  ],
  plans: [
    { id: "p1", name: "30 minutes", active: true, price_ngn: 3000, price_usd: 20, video_minutes: 30, audio_minutes: 0, video_audio_minutes: 0, market: "both", currency: "NGN", sort_order: 1, created_at: PAST },
  ],
  api_keys: [], usage_sessions: [], call_requests: [], device_trial_grants: [], devices: [], contact_messages: [], fal_balances: [], key_usage: [], airtime: [],
};

const STUB = `
<script>
(function () {
  const DATA = ${JSON.stringify(DATA)};
  const USER = { id: "u-admin", aud: "authenticated", role: "authenticated", email: "owner@proof.local",
    phone: "", confirmed_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z",
    last_sign_in_at: "2026-01-01T00:00:00Z", app_metadata: {}, user_metadata: {}, identities: [],
    aud_: "authenticated", session_id: "s-proof" };
  const SESSION = { access_token: "stub-access-token", token_type: "bearer", expires_in: 360000,
    expires_at: Math.floor(Date.now() / 1000) + 360000, refresh_token: "stub-refresh", user: USER };

  // A PostgREST builder. Every chainable verb hands back itself, so whatever order the panel
  // asks its filters in, the read still answers with the rows for that table.
  function builder(table) {
    const rows = DATA[table] ?? [];
    const f = [];
    const b = {
      select() { return b; },
      insert(body) { window.__writes.push({ table, verb: "insert", body, filters: f }); return b; },
      update(body) { window.__writes.push({ table, verb: "update", body, filters: f }); return b; },
      delete() { window.__writes.push({ table, verb: "delete" }); return b; }, upsert() { return b; },
      eq(k, v) { f.push(["eq", k, v]); return b; }, neq(k, v) { f.push(["neq", k, v]); return b; },
      gt(k, v) { f.push(["gt", k, v]); return b; }, gte(k, v) { f.push(["gte", k, v]); return b; },
      lt(k, v) { f.push(["lt", k, v]); return b; }, lte(k, v) { f.push(["lte", k, v]); return b; },
      like() { return b; }, ilike() { return b; }, is(k, v) { f.push(["is", k, v]); return b; }, in() { return b; }, contains() { return b; },
      order() { return b; }, limit() { return b; }, range() { return b; }, single() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
      maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
      then(res, rej) {
        // What window the panel actually asked for is the figure the clock proof checks, so the
        // builder has to say which filter it was handed rather than only which rows came back.
        window.__reads.push({ table, filters: f.slice() });
        return Promise.resolve({ data: rows.slice(), error: null, count: rows.length }).then(res, rej);
      },
    };
    return b;
  }
  window.__writes = [];
  window.__reads = [];
  // Every list opens unfolded for the proof, so the rows are on screen without a press.
  try { ["video", "audio", "video_audio"].forEach((k) => localStorage.setItem("streamlive.calls.folded." + k, "0")); } catch (e) { }
  window.supabase = {
    createClient() {
      return {
        auth: {
          getSession: () => Promise.resolve({ data: { session: SESSION }, error: null }),
          getUser: () => Promise.resolve({ data: { user: USER }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signOut: () => Promise.resolve({ error: null }),
        },
        from: (t) => builder(t),
        // The account drawer is painted from this RPC, not from the tables. Deliberately no
        // burn_rate key inside the wallets: that is the figure the credit window used to trust, and
        // the proof has to show the column reads the rate history instead.
        // sl_server_time is what the clock strip measures against. Answer it 721 minutes BEHIND this
        // machine, which is the exact gap his own screenshot shows, so the proof tests the panel with
        // a badly-off clock rather than a convenient one.
        rpc: (name) => Promise.resolve({
          data: name === "sl_server_time" ? ${JSON.stringify(SERVER_ISO)}
            : name === "sl_account_snapshot" ? {
            ok: true, status: "active", paid: true, plan_id: "p1",
            modalities: { video: true, audio: true, video_audio: true },
            cloning_mode: "voice_video", max_concurrent_sessions: 1,
            wallets: [
              { modality: "video", balance: "20.0", unlimited: false, total_credited: "30.0", total_spent: "10.0" },
              { modality: "audio", balance: "4.0", unlimited: false, total_credited: "4.0", total_spent: "0.0" },
            ],
            open_sessions: [],
          } : null,
          error: null, fn: name,
        }),
        storage: { from: () => ({ list: () => Promise.resolve({ data: [], error: null }), download: () => Promise.resolve({ data: null, error: null }) }) },
        functions: { invoke: () => Promise.resolve({ data: { ok: true }, error: null }) },
      };
    },
  };
  // The panel's own admin-api calls go through fetch, not the client. Answer every one of them with
  // ok, and give the two reads the tables expect so a card never blanks for the wrong reason.
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = String(url || "");
    if (u.includes("/functions/v1/")) {
      const action = (() => { try { return JSON.parse(opts.body).action; } catch (e) { return ""; } })();
      const body = action === "calls" ? ${JSON.stringify(CALLS)}
        : action === "resolve" ? { ok: true, users: [] }
        : action === "fal_balance" ? { ok: true, configured: true, tail: "••••9f2c", label: "billing",
            balance: 74.64, currency: "USD",
            today: { cost: 30, seconds: 9000 }, month: { cost: 120, seconds: 36000 },
            per_second: 0.02083, per_second_source: "fal", minutes_left: 400, keys: [], live: null,
            from_cache: false, detail: "stubbed reading for the offline proof",
            no_frame: { today: { sessions: 5, seconds: 21.4 }, month: { sessions: 9, seconds: 118.2 },
              blank: ${JSON.stringify(BLANK)} } }
        : action === "trial_supply" ? { ok: true, keys: [] }
        : { ok: true };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
    }
    return realFetch(url, opts);
  };
  window.__stubErrors = [];
  window.addEventListener("error", (e) => window.__stubErrors.push(String(e.message)));
  console.log = () => {};
  const warn = console.warn; console.warn = () => warn;
})();
</script>
`;

// The stub is assembled by interpolation, so a miscounted brace here would produce a boot copy
// that renders a blank card and looks like a bug in the panel. Parse the injected script before
// writing it: a broken harness fails loudly at generation time instead.
const stubJs = STUB.replace(/^[\s\S]*?<script>/, "").replace(/<\/script>[\s\S]*$/, "");
try { new Function(stubJs); } catch (e) { fs.writeFileSync(HERE + "/tmp-stub-dump.js", stubJs); throw new Error(`the stub does not parse: ${e.message}`); }

// Replace only the CDN supabase-js tag with the stub; the app's own <script> is left byte for byte.
const CDN = /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"><\/script>/;
if (!CDN.test(panel)) throw new Error("the CDN supabase-js tag is not where the harness expects it");
const out = panel.replace(CDN, STUB);
const file = HERE + `/tmp-panel-boot${SC ? "-" + SC : ""}.html`;
fs.writeFileSync(file, out, "utf8");
console.log("wrote", file, fs.statSync(file).size, "bytes (built panel is", panel.length, "chars; only the CDN tag was replaced)");
