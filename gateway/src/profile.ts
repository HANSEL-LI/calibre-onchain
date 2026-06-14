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
  // Forecasting-track stats (#597), derived calibre-side from the user's settled
  // (resolved non-void) markets; all null until a market resolves (null→unset).
  win_rate: number | null; // wins / settled markets (ratio)
  n_resolved: number | null; // count of resolved (non-void) markets traded
  streak: number | null; // signed current run, +wins/−losses, most-recent-first
  wallet_address: string | null;
  discord_handle: string | null;
  riot_id: string | null;
  clan: string | null;
  // ENS-standard records (#596), derived calibre-side from display_name + tier.
  // Always-present strings on a resolved profile (typed null-safe for forward-compat).
  avatar: string | null; // https URL of the rank-coloured generated avatar SVG
  url: string | null; // the user's public calibre profile link
  description: string | null; // short derived one-liner ("Calibre forecaster — {tier}")
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
  // Forecasting-track stats (#597) — same fmtNum null→unset path as brier/roi;
  // n_resolved/streak are integers calibre-side, rendered without a decimal.
  "gg.calibre.winrate": (p: PublicProfile) => fmtNum(p.win_rate),
  "gg.calibre.resolved": (p: PublicProfile) => fmtNum(p.n_resolved),
  "gg.calibre.streak": (p: PublicProfile) => fmtNum(p.streak),
  "com.discord": (p: PublicProfile) => p.discord_handle ?? "",
  "gg.calibre.riot": (p: PublicProfile) => p.riot_id ?? "",
  "gg.calibre.clan": (p: PublicProfile) => p.clan ?? "",
  // ENS-standard keys (#596) — generic wallets / etherscan / the ENS app render
  // these for free. calibre always sends a string; `?? ""` keeps the unset→"" (no
  // record) semantics uniform and robust if a value ever comes back null.
  avatar: (p: PublicProfile) => p.avatar ?? "",
  url: (p: PublicProfile) => p.url ?? "",
  description: (p: PublicProfile) => p.description ?? "",
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

// ── Clan-aggregate records (#583 — bare `<clan>.hicalibre.eth`) ──
//
// A separate namespace from the per-user `TEXT_RECORD_KEYS` above. The clan keys
// (`gg.calibre.clan.{size,avgrank,brier,roi}`) describe a CLAN profile, not a
// user, so they are deliberately NOT part of the canonical user-key drift
// contract pinned by `test/keys-schema.test.ts` (ranking/keys.json). The
// existing single `gg.calibre.clan` user key — a user's clan *label* — is
// distinct from these dotted clan-aggregate keys, so the two namespaces do not
// collide.

/** Clan-aggregate card from calibre's `GET /api/v1/clans/{clan}` (Seam 2, #583). */
export interface ClanProfile {
  clan: string;
  size: number; // count of public human members
  avg_rank: string; // canonical-ladder tier of the mean member skill ("Static" floor)
  brier_skill: number | null; // pooled clan Brier skill; null until a member is scored
  median_brier_skill: number | null;
  roi: number | null; // Σ net / Σ deployed; null below the deployed floor
  top_member: string | null; // highest-skill member's display_name; null if none scored
  // ENS-standard records (#633) so a bare <clan>.hicalibre.eth renders as a
  // profile in generic ENS UIs, derived calibre-side like the per-user records.
  avatar: string | null; // https URL of the generated clan avatar SVG
  url: string | null; // the clan's public calibre profile link
  description: string | null; // short derived one-liner ("Calibre clan — N members · avg {tier}")
}

/** ENS text-record keys served on a bare clan name → the clan-card field. */
export const CLAN_TEXT_RECORD_KEYS = {
  "gg.calibre.clan.size": (c: ClanProfile) => String(c.size),
  "gg.calibre.clan.avgrank": (c: ClanProfile) => c.avg_rank,
  "gg.calibre.clan.brier": (c: ClanProfile) => fmtNum(c.brier_skill),
  "gg.calibre.clan.median": (c: ClanProfile) => fmtNum(c.median_brier_skill),
  "gg.calibre.clan.roi": (c: ClanProfile) => fmtNum(c.roi),
  "gg.calibre.clan.top": (c: ClanProfile) => c.top_member ?? "",
  // ENS-standard keys (#633) — same as the per-user keys, so the ENS app renders
  // a clan name's avatar + description for free.
  avatar: (c: ClanProfile) => c.avatar ?? "",
  url: (c: ClanProfile) => c.url ?? "",
  description: (c: ClanProfile) => c.description ?? "",
} as const satisfies Record<string, (c: ClanProfile) => string>;

export type ClanTextRecordKey = keyof typeof CLAN_TEXT_RECORD_KEYS;

/** True iff `key` is a clan-aggregate record key (vs a per-user record key). */
export function isClanRecordKey(key: string): key is ClanTextRecordKey {
  return key in CLAN_TEXT_RECORD_KEYS;
}

/** The clan text value for `key`, or "" for an unknown/unset clan key. */
export function clanTextRecord(clan: ClanProfile, key: string): string {
  const reader = (CLAN_TEXT_RECORD_KEYS as Record<string, (c: ClanProfile) => string>)[key];
  return reader ? reader(clan) : "";
}

export interface ClanClient {
  /** Fetch a clan aggregate by name. Returns null on 404 (unknown / no members). */
  fetch(clan: string): Promise<ClanProfile | null>;
}

/** HTTP-backed clan client against `apiBase`. `fetchImpl` is injectable for tests. */
export function createClanClient(
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
): ClanClient {
  return {
    async fetch(clan: string): Promise<ClanProfile | null> {
      const url = `${apiBase}/clans/${encodeURIComponent(clan)}`;
      const res = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`clan API ${res.status} for ${clan}`);
      }
      return (await res.json()) as ClanProfile;
    },
  };
}
