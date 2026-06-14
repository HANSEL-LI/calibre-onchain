/**
 * Public "which side you're backing" roles for the NEXT upcoming match (#581).
 *
 * For the single soonest upcoming match that has an open market, the bot reads
 * calibre's **service-authed** `GET /api/v1/markets/{id}/sides` (predominant side
 * per public holder), maps each calibre `display_name` back to a linked Discord
 * member (via the #582 identity registry), and assigns a public
 * `Backing <TeamA>` / `Backing <TeamB>` role — created on demand in a team
 * colour. Roles are cleared when the match locks / settles (it leaves the
 * upcoming window), and **only one match is active at a time**.
 *
 * ⚠️ Privacy: this INTENTIONALLY reveals each member's market position publicly —
 * the deliberate opposite of the rank-role privacy invariant ({@link ./roles}).
 * Owner-approved in #581 as a public social mechanic ("two camps before
 * kickoff"). This is the ONLY role surface that exposes trading activity.
 *
 * Split pure-core / thin-IO (mirrors {@link ./matches}): the side-role naming,
 * the active-match pick, the `display_name → member` join, and the assign/strip
 * diff are pure + unit-tested; only {@link fetchSides} touches the network.
 */
import type { UpcomingMatch } from "./matches.js";
import { matchMarket, type PublicMarket } from "./matches.js";

/** A holder's predominant side from `GET /markets/{id}/sides`. */
export interface SideHolder {
  /** calibre public display_name — the ENS subname leftmost label. */
  display_name: string;
  /** 'yes' | 'no' — predominant (net) side. */
  side: "yes" | "no";
}

/** The `GET /api/v1/markets/{id}/sides` response (service-authed). */
export interface SidesResponse {
  market_id: number;
  match_id: string;
  question: string;
  /** YES team label → role `Backing <outcome_yes>`. */
  outcome_yes: string;
  outcome_no: string;
  status: string;
  holders: SideHolder[];
}

/** The Discord role name a side maps to: `Backing <Team>`. Pure. */
export function backingRoleName(team: string): string {
  return `Backing ${team.trim()}`;
}

/** Whether `roleName` is a bot-managed side role (so only those are stripped). */
export function isBackingRoleName(roleName: string): boolean {
  return roleName.startsWith("Backing ");
}

/**
 * A stable Discord role colour for a team name, deterministic so a team keeps
 * its colour across matches without any palette config. FNV-1a over the
 * lowercased name → an HSL-derived RGB clamped to a mid-bright band (legible on
 * Discord's dark theme: full saturation, ~55% lightness). Pure.
 */
export function teamColor(team: string): number {
  let h = 0x811c9dc5;
  const name = team.trim().toLowerCase();
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hue = (h >>> 0) % 360;
  return hslToRgb(hue, 0.7, 0.55);
}

/** HSL (h∈[0,360), s,l∈[0,1]) → packed 0xRRGGBB. Pure. */
function hslToRgb(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to255 = (v: number) => Math.round((v + m) * 255) & 0xff;
  return (to255(r) << 16) | (to255(g) << 8) | to255(b);
}

/**
 * Pick the single ACTIVE match: the soonest upcoming match (in `matches`
 * order — calibre returns them soonest-first) that has both team names and a
 * joined open market. Returns the match + its market, or null if none qualifies
 * (no upcoming match has an open market). Pure.
 *
 * Mirrors {@link desiredChannels}'s eligibility (upcoming + both teams) but
 * REQUIRES a market — a side-role match must have a market to read sides from.
 */
export function activeMatch(
  matches: readonly UpcomingMatch[],
  markets: readonly PublicMarket[],
): { match: UpcomingMatch; market: PublicMarket } | null {
  for (const match of matches) {
    if (match.status && match.status !== "upcoming") continue;
    if (!match.team1.trim() || !match.team2.trim()) continue;
    const market = matchMarket(match, markets);
    if (market) return { match, market };
  }
  return null;
}

/**
 * Reverse the `discordId → ensName` link registry into a `display_name →
 * discordId` map for the side-role join. The registry's ENS name is
 * `<display_name>.<parent>` lowercased (see identity.ensNameFor); the leftmost
 * label before the first `.` is the display_name. Comparison is lowercased so a
 * holder's `display_name` from calibre joins regardless of case. Pure.
 *
 * If two members somehow share a leftmost label, last-write-wins — display
 * names are globally unique in calibre, so this is defensive only.
 */
export function displayNameToMemberId(links: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [memberId, ensName] of links) {
    const label = ensName.split(".", 1)[0]?.toLowerCase();
    if (label) out.set(label, memberId);
  }
  return out;
}

/** The desired side role for one linked member. */
export interface MemberSideAssignment {
  memberId: string;
  /** The exact `Backing <Team>` role name to hold. */
  roleName: string;
}

/**
 * Pure: from a `/sides` response + the reversed link map, compute the desired
 * side-role assignment per linked member. Holders whose `display_name` isn't a
 * linked Discord member are skipped (they have no member to role). The YES side
 * maps to `Backing <outcome_yes>`, NO to `Backing <outcome_no>`.
 */
export function desiredSideAssignments(
  sides: SidesResponse,
  byDisplayName: ReadonlyMap<string, string>,
): MemberSideAssignment[] {
  const out: MemberSideAssignment[] = [];
  for (const h of sides.holders) {
    const memberId = byDisplayName.get(h.display_name.toLowerCase());
    if (!memberId) continue;
    const team = h.side === "yes" ? sides.outcome_yes : sides.outcome_no;
    out.push({ memberId, roleName: backingRoleName(team) });
  }
  return out;
}

/**
 * Reconcile ONE member's managed `Backing *` roles toward `wantRoleName`
 * (`null` = should hold no side role, e.g. they're no longer a holder or the
 * match cleared). Only `Backing *` roles are touched; any other role is left
 * alone. Idempotent: holding exactly the right side role yields an empty delta.
 * Mirrors {@link reconcileRoles}. Pure.
 */
export function reconcileSideRoles(
  currentRoleNames: readonly string[],
  wantRoleName: string | null,
): { add: string[]; remove: string[] } {
  const heldManaged = currentRoleNames.filter(isBackingRoleName);
  const remove = heldManaged.filter((r) => r !== wantRoleName);
  const add = wantRoleName && !heldManaged.includes(wantRoleName) ? [wantRoleName] : [];
  return { add, remove };
}

/**
 * Fetch the service-authed sides for a market. Sends the
 * `X-Calibre-Markets-Token` service header. Throws on a non-2xx so the caller
 * can isolate the pass (the side-role loop must never stall the rank loop).
 */
export async function fetchSides(
  apiBase: string,
  marketId: number,
  serviceToken: string,
): Promise<SidesResponse> {
  const res = await fetch(`${apiBase}/api/v1/markets/${marketId}/sides`, {
    headers: { "X-Calibre-Markets-Token": serviceToken },
  });
  if (!res.ok) throw new Error(`markets/${marketId}/sides ${res.status}`);
  return (await res.json()) as SidesResponse;
}
