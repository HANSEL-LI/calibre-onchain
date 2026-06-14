/**
 * Clan → Discord role mapping + the (pure) reconcile that decides which clan
 * role to add/remove for a member given their clan label (read from the
 * `gg.calibre.clan` ENS record; see {@link ./rank}).
 *
 * Unlike rank tiers (a fixed 7-name ladder in {@link ./roles}), clans are an
 * OPEN set of free-text labels a user sets on their profile — so clan roles are
 * created on demand (one per distinct label) and identified by a name PREFIX
 * (`clan:<label>`). That prefix is how the bot tells its managed clan roles apart
 * from rank roles + human-created roles, so the reconcile only ever touches its
 * own. Labels are matched case-sensitively (verbatim from the profile).
 *
 * Privacy invariant (mirrors {@link ./roles}): a clan role reveals a public team
 * label and nothing about trades — clan-aggregate stats (`gg.calibre.clan.*`)
 * are never read for role derivation.
 */

/** Prefix marking a bot-managed clan role. */
export const CLAN_ROLE_PREFIX = "clan:";

// Discord caps role names at 100 chars; the prefix eats some of that budget.
const MAX_ROLE_NAME = 100;

/**
 * The Discord role name for a clan label: `clan:<label>`, trimmed and clamped to
 * Discord's 100-char role-name limit. (The calibre profile already caps the
 * label at 64 chars, so the clamp is a backstop.)
 */
export function clanRoleName(label: string): string {
  return `${CLAN_ROLE_PREFIX}${label.trim()}`.slice(0, MAX_ROLE_NAME);
}

/** Whether `name` is a bot-managed clan role (carries the prefix). */
export function isManagedClanRole(name: string): boolean {
  return name.startsWith(CLAN_ROLE_PREFIX);
}

export interface ClanRoleDelta {
  /** Managed clan-role names to add (0 or 1). */
  add: string[];
  /** Managed clan-role names to remove. */
  remove: string[];
}

/**
 * Reconcile a member's managed clan roles toward the one implied by `clan`.
 *
 * `currentRoleNames` is the member's full current role-name set; only
 * clan-prefixed roles are ever touched (unmanaged roles, incl. rank roles, are
 * left alone). A `null` / empty clan removes all managed clan roles and adds
 * none — the member simply has no clan role. Idempotent: if the member already
 * holds exactly the right clan role, the delta is empty.
 */
export function reconcileClanRole(
  currentRoleNames: readonly string[],
  clan: string | null,
): ClanRoleDelta {
  const want = clan && clan.trim() ? clanRoleName(clan) : null;
  const heldManaged = currentRoleNames.filter(isManagedClanRole);
  const remove = heldManaged.filter((r) => r !== want);
  const add = want && !heldManaged.includes(want) ? [want] : [];
  return { add, remove };
}
