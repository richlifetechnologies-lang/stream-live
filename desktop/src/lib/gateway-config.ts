import pkg from "../../package.json";
import type { GatewayConfig } from "@stream-live/client";

// The anon key ships in the bundle on purpose: it only opens RLS-guarded reads, and
// every money RPC (sl_start_session / sl_lease / sl_grant_credits / sl_pick_keys) is
// service-role only — a client JWT can never call them. See
// supabase/migrations/20261011000000_stream_live_credits.sql.
const PLACEHOLDER_SUPABASE_URL = "https://onhanfathvfkkliayvrn.supabase.co";
const PLACEHOLDER_ANON_KEY = "YOUR-ANON-KEY";

// appVersion must reach the gateway: it drives the minimum-version kill switch
// (start-session answers 412 update_required when the build is too old).
export const GATEWAY_CONFIG: GatewayConfig = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? PLACEHOLDER_SUPABASE_URL,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? PLACEHOLDER_ANON_KEY,
  // fal names an app owner/name, and the stream page opens decart/lucy-2-5/realtime, so
  // the call token has to be allowed for decart/lucy-2-5. The bare "lucy-2-5" this used to
  // send is not an app fal knows: the mint still answered, and the call then died a few
  // seconds in without a picture.
  falAppId: "decart/lucy-2-5",
  appVersion: pkg.version,
};

// A build made without the env vars below cannot reach the gateway at all; saying
// so beats the "invalid API key" the GoTrue call would otherwise return. Status
// itself is surfaced by App's status banner as soon as the window loads — long
// before sign-in — because a mis-built installer otherwise looks healthy.
export const GATEWAY_CONFIGURED =
  GATEWAY_CONFIG.supabaseAnonKey !== PLACEHOLDER_ANON_KEY &&
  !GATEWAY_CONFIG.supabaseAnonKey.startsWith("YOUR-") &&
  GATEWAY_CONFIG.supabaseUrl.startsWith("https://");
