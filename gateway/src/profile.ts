/**
 * Typed client for calibre's public profile API (Seam 2) + the ENS record-key
 * mapping. This is the gateway's ONLY data source — it never touches the DB.
 *
 * Contract (calibre `src/calibre/web/profiles_api.py`, #419):
 *   GET {apiBase}/profiles/{display_name}
 *   200 → PublicProfile JSON below
 *   404 → unknown / bot / not-opted-in / unnamed — all indistinguishable
 *         (no enumeration oracle); the gateway maps this to "no records".
 */

/** The Seam 2 public profile card. Every field except display_name/tier nullable. */
export interface PublicProfile {
  display_name: string;
  tier: string; // coarse rank label from the calibre ladder, floor→top: "Static" | "Hunch" | "Read" | "Edge" | "Sharp" | "Seer" | "Oracle"
  brier_skill: number | null; // 1 − brier_avg/0.25; >0 beats a coin-flip
  roi: number | null; // net / lifetime-deployed; null below the deployed floor
  pnl: number | null; // net P&L in base units (÷10_000 = points); null if never traded
  wallet_address: string | null;
  discord_handle: string | null;
  riot_id: string | null;
  clan: string | null;
}

/**
 * The canonical ENS text-record keys this gateway answers, mapped to the
 * profile fields they read. The `ranking/` lib owns the canonical schema;
 * this is the gateway's view of it. Null source values → the record is unset
 * (answered as ""), which is indistinguishable from "never set".
 */
export const TEXT_RECORD_KEYS = {
  "gg.calibre.rank": (p: PublicProfile) => p.tier,
  "gg.calibre.brier": (p: PublicProfile) => fmtNum(p.brier_skill),
  "gg.calibre.roi": (p: PublicProfile) => fmtNum(p.roi),
  "com.discord": (p: PublicProfile) => p.discord_handle ?? "",
  "gg.calibre.riot": (p: PublicProfile) => p.riot_id ?? "",
  "gg.calibre.clan": (p: PublicProfile) => p.clan ?? "",
} as const satisfies Record<string, (p: PublicProfile) => string>;

export type TextRecordKey = keyof typeof TEXT_RECORD_KEYS;

function fmtNum(n: number | null): string {
  // Floats are stringified at full precision; null (unqualified) → unset.
  return n === null || n === undefined ? "" : String(n);
}

/** The text value for `key` from `profile`, or "" for an unknown/unset key. */
export function textRecord(profile: PublicProfile, key: string): string {
  const reader = (TEXT_RECORD_KEYS as Record<string, (p: PublicProfile) => string>)[key];
  return reader ? reader(profile) : "";
}

/** The ETH (coinType 60) address for `addr()`, lowercased, or "" if unset. */
export function addrRecord(profile: PublicProfile): string {
  return profile.wallet_address ?? "";
}

export interface ProfileClient {
  /** Fetch a profile by display_name. Returns null on 404 (no leak). */
  fetch(displayName: string): Promise<PublicProfile | null>;
}

/** HTTP-backed profile client against `apiBase`. `fetchImpl` is injectable for tests. */
export function createProfileClient(
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
): ProfileClient {
  return {
    async fetch(displayName: string): Promise<PublicProfile | null> {
      const url = `${apiBase}/profiles/${encodeURIComponent(displayName)}`;
      const res = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`profile API ${res.status} for ${displayName}`);
      }
      return (await res.json()) as PublicProfile;
    },
  };
}
