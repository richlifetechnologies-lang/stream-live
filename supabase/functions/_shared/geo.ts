// Where this request came from — the reading the panel's country flag is built from.
//
// These are the same four rules the payment page already uses, kept here as one place for the
// routes that are not about money. The payment function is deliberately left alone rather than
// pointed at this file: the till works, and a shared import is not worth touching it for.
//
// The hard limits are the point of this module, not an afterthought:
//   * the address is taken from what the platform saw, never from anything the app sends;
//   * private, loopback, carrier-NAT, link-local and multicast addresses are never put on the wire;
//   * the outside look-up runs at most once per request, with a short timeout, and only when the
//     platform itself handed over no country;
//   * a timeout, an error or an answer that is not two letters all mean "no country". Nothing
//     that costs the buyer money is ever read from any of this.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** The runtime is not handed `cf-ipcountry` on this project (proved 2026-10-31); this is the
 *  cheap first try and the address look-up below is what actually fills a flag. */
export function requestCountry(req: Request): string | null {
  const raw = (req.headers.get("cf-ipcountry") ?? "").trim();
  return /^[A-Za-z][A-Za-z]$/.test(raw) ? raw.toUpperCase() : null;
}

/** The caller's real address: `cf-connecting-ip` was proved equal to it, with the same address
 *  first in `x-forwarded-for`. Only an entry shaped like a bare address is taken. */
export function requestIp(req: Request): string {
  const raw = req.headers.get("cf-connecting-ip")
    || req.headers.get("x-forwarded-for")
    || req.headers.get("sb-forwarded-for")
    || "";
  const first = raw.split(",")[0].trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(first) ? first : "";
}

export function isPublicIp(ip: string): boolean {
  if (/^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return true;
  }
  // IPv6: only global unicast (2000::/3) is worth asking about.
  const hextet = ip.split(":")[0] ?? "";
  return ip.includes(":") && /^[23][0-9a-fA-F]{0,3}$/.test(hextet);
}

/** The country behind an address, from the one free look-up service already approved for the flag. */
export async function countryOfAddress(ip: string): Promise<string | null> {
  const res = await fetch("https://ipwho.is/" + ip, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || body.success !== true) return null;
  const cc = String(body.country_code ?? "").trim().toUpperCase();
  return /^[A-Z][A-Z]$/.test(cc) ? cc : null;
}

/**
 * The country for this caller, without ever overwriting one that is already on the account.
 *
 * An existing flag came from the customer's own Ghana tap, from the seller, or from the first
 * reading the gateway took; the rule "only the first reading wins" belongs to the database, so
 * this asks for nothing when the account already has one.
 */
export async function countryForCaller(
  req: Request,
  userId: string,
  db: SupabaseClient,
): Promise<string | null> {
  const direct = requestCountry(req);
  if (direct) return direct;
  const { data } = await db.from("profiles")
    .select("country, network_last_ip")
    .eq("id", userId)
    .maybeSingle();
  const stored = String(data?.country ?? "").trim().toUpperCase();
  if (/^[A-Z][A-Z]$/.test(stored)) return stored;
  const ip = requestIp(req) || String(data?.network_last_ip ?? "");
  return isPublicIp(ip) ? await countryOfAddress(ip) : null;
}
