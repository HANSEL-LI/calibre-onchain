/**
 * Tier → Discord role mapping and the (pure) reconcile that decides which roles
 * to add/remove for a member given their ENS-read tier.
 *
 * Privacy invariant: the managed role set is derived ONLY from rank tiers.
 * There are no position/P&L/ROI-derived roles here — a member's roles reveal
 * their rank and nothing about their open trades.
 */

// The ladder tier names, lowest → highest. Mirrors the canonical
// `calibre_ranking.all_tiers()` ladder (#430); duplicated here (not imported)
// because this is the TS service and the lib is Python — the two are kept in
// sync by the shared schema, asserted in tests.
export const LADDER_TIERS = [
  "Static",
  "Hunch",
  "Read",
  "Edge",
  "Sharp",
  "Seer",
  "Oracle",
] as const;

export type Tier = (typeof LADDER_TIERS)[number];

/** The Discord role name for a tier — the bare tier label (e.g. "Oracle"). */
export function roleNameForTier(tier: Tier): string {
  return tier;
}

/**
 * The pre-rename role name this bot used to create (`calibre:<Tier>`). Kept so
 * {@link ensureManagedRoles} can find and rename existing roles in place rather
 * than orphaning them and creating bare-named duplicates.
 */
export function legacyRoleNameForTier(tier: Tier): string {
  return `calibre:${tier}`;
}

/**
 * Per-tier presentation. `color` is the Discord role colour (0xRRGGBB), mirrored
 * 1:1 from the calibre web rank ramp (`style.css` `--tier-*`) so a member's role
 * colour matches their in-app name: dim grey → cyan → green → electric blue →
 * violet `Seer` → near-white apex `Oracle`. Keep these in parity with the CSS
 * `--tier-*` values (pinned in `test/roles.test.ts`). `hoist` shows the role as
 * its own group in the member sidebar; only the top three ranks are hoisted so
 * elite status stands out without cluttering the list. `emoji` is a unicode role
 * icon (best-effort — requires guild Boost level 2, applied in a try/catch so
 * non-boosted guilds simply skip it).
 */
export interface TierStyle {
  color: number;
  hoist: boolean;
  emoji: string;
}

export const TIER_STYLE: Record<Tier, TierStyle> = {
  Static: { color: 0x5f5e5a, hoist: false, emoji: "▪️" }, // --tier-static
  Hunch: { color: 0x8a93a3, hoist: false, emoji: "🌱" }, // --tier-hunch
  Read: { color: 0x7fc6ff, hoist: false, emoji: "👁️" }, // --tier-read
  Edge: { color: 0x5eeea0, hoist: false, emoji: "⚡" }, // --tier-edge
  Sharp: { color: 0x5b8cff, hoist: true, emoji: "🎯" }, // --tier-sharp
  Seer: { color: 0xb58cff, hoist: true, emoji: "🔮" }, // --tier-seer
  Oracle: { color: 0xeef4ff, hoist: true, emoji: "👑" }, // --tier-oracle
};

/** Every role name this bot manages — exactly the per-tier roles, nothing else. */
export const MANAGED_ROLE_NAMES: readonly string[] = LADDER_TIERS.map(roleNameForTier);

const MANAGED_SET = new Set(MANAGED_ROLE_NAMES);
const TIER_SET = new Set<string>(LADDER_TIERS);

/** Whether `tier` is a known ladder tier (rejects "Unranked", typos, etc.). */
export function isTier(tier: string): tier is Tier {
  return TIER_SET.has(tier);
}

/**
 * Ladder position of a tier (0 = Static … 6 = Oracle); -1 for null/unknown.
 * Used to decide whether a reconcile crossed *upward* (a promotion to announce).
 */
export function tierIndex(tier: string | null): number {
  return tier ? LADDER_TIERS.indexOf(tier as Tier) : -1;
}

export interface RoleDelta {
  /** Managed role names to add. */
  add: string[];
  /** Managed role names to remove. */
  remove: string[];
}

/**
 * Reconcile a member's managed roles toward the role implied by `tier`.
 *
 * `currentRoleNames` is the member's full current role-name set; only roles in
 * the managed set are ever touched (unmanaged roles are left untouched). A
 * `null` / unknown / non-ladder tier (e.g. "Unranked", or a name with no rank
 * record) removes all managed roles and adds none — the member simply has no
 * rank role. Idempotent: if the member already holds exactly the right managed
 * role, the delta is empty.
 */
export function reconcileRoles(currentRoleNames: readonly string[], tier: string | null): RoleDelta {
  const want = tier && isTier(tier) ? roleNameForTier(tier) : null;
  const heldManaged = currentRoleNames.filter((r) => MANAGED_SET.has(r));

  const remove = heldManaged.filter((r) => r !== want);
  const add = want && !heldManaged.includes(want) ? [want] : [];

  return { add, remove };
}
