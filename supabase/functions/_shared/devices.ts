// Device binding for the desktop app. A device is only *bound* when a paid
// session actually starts, so browsing the dashboard from a random machine cannot
// eat a slot. Revoked devices are never re-bound implicitly.
import { adminClient } from "./db.ts";

export type DeviceCheck = { allowed: boolean; reason?: string; bound?: boolean };

export async function checkAndBindDevice(
  userId: string,
  deviceId: string | undefined,
  maxDevices: number,
): Promise<DeviceCheck> {
  if (!deviceId) return { allowed: true, bound: false };

  const db = adminClient();
  const { data: existing, error } = await db
    .from("devices")
    .select("id, revoked")
    .eq("user_id", userId)
    .eq("device_id", deviceId)
    .maybeSingle();
  if (error) throw new Error(`device lookup failed: ${error.message}`);

  if (existing?.revoked) return { allowed: false, reason: "device_revoked" };

  if (existing) {
    await db
      .from("devices")
      .update({ last_seen: new Date().toISOString() })
      .eq("id", existing.id);
    return { allowed: true, bound: false };
  }

  const { count } = await db
    .from("devices")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("revoked", false);
  if ((count ?? 0) >= Math.max(1, maxDevices)) {
    return { allowed: false, reason: "device_limit_reached" };
  }

  const { error: insErr } = await db.from("devices").insert({ user_id: userId, device_id: deviceId });
  if (insErr) throw new Error(`device bind failed: ${insErr.message}`);
  return { allowed: true, bound: true };
}

/** How many devices this account may bind, from its plan row. */
export async function planMaxDevices(planId: string | undefined): Promise<number> {
  if (!planId) return 1;
  const { data } = await adminClient().from("plans").select("max_devices").eq("id", planId).maybeSingle();
  return Number(data?.max_devices ?? 1);
}

/**
 * Compare two dotted versions without a semver dependency. Returns -1/0/1.
 * A prerelease suffix ("1.2.0-beta.3") is compared on the numeric part only.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v || "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
