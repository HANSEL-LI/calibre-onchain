/**
 * Per-match Discord channel lifecycle (#580).
 *
 * The bot pulls calibre's **public** match + market data over HTTP and ensures
 * exactly one text channel per upcoming match, with a pinned message carrying
 * the market link + current odds. When a match leaves the upcoming window
 * (settled / started / expired) its channel is archived. All reads are public,
 * no-auth — the bot holds no calibre session and reads no private surface.
 * Ranks still come from ENS only (see {@link ./rank}); this is the *match-data*
 * leg, not a rank read.
 *
 * This module is split pure-core / thin-IO on purpose (mirrors the W6.4 split):
 * channel naming, the match→market join, the pinned-message text, and the
 * create/archive diff are pure and unit-tested; only {@link fetchUpcomingMatches}
 * / {@link fetchPublicMarkets} touch the network.
 */

/** One upcoming match from `GET /api/v1/matches/upcoming` (public). */
export interface UpcomingMatch {
  /** VLR match id — stable, the deterministic-name seed + `#matches/<id>` deep link. */
  match_id: string;
  team1: string;
  team2: string;
  event?: string;
  /** Bracket / stage, e.g. "Playoffs–Lower Round 1" / "Upper Semifinals". */
  series?: string;
  /** Local kickoff clock, e.g. "4:00 PM". */
  time?: string;
  /** Human date, e.g. "Sun, June 14, 2026". */
  date_group?: string;
  status?: string;
}

/** One open market from `GET /api/v1/markets/public/markets` (public). */
export interface PublicMarket {
  market_id: number;
  question: string;
  team1: string;
  team2: string;
  /** YES price in micro-cents, canonical lmsr scale [1, 9999] (÷100 = percent). */
  price_yes: number;
}

/**
 * Slugify a team name to Discord channel-name-safe characters: lowercase,
 * `[a-z0-9-]` only, collapsed/trimmed dashes. Pure.
 */
export function slugifyTeam(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A short, stable hex tag derived from the match id, so two same-matchup
 * channels (rematches across stages) never collide and a channel name
 * round-trips to its match. Pure, deterministic (FNV-1a, 6 hex chars).
 */
export function matchTag(matchId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < matchId.length; i++) {
    h ^= matchId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

/**
 * Deterministic, idempotent Discord channel name for a match:
 * `<teamA>-vs-<teamB>-<tag>`, lowercased and clamped to Discord's 100-char
 * limit. The trailing `matchTag` makes the name unique + reversible to the
 * match (the join key the bot owns). Pure — re-running finds the same name.
 */
export function channelNameFor(match: UpcomingMatch): string {
  const a = slugifyTeam(match.team1) || "tbd";
  const b = slugifyTeam(match.team2) || "tbd";
  const tag = matchTag(match.match_id);
  // Reserve room for "-vs-" + "-" + 6-char tag within the 100-char ceiling.
  const base = `${a}-vs-${b}`.slice(0, 92);
  return `${base}-${tag}`;
}

/** Whether `channelName` is a per-match channel for `match` (carries its tag). */
export function isChannelForMatch(channelName: string, match: UpcomingMatch): boolean {
  return channelName === channelNameFor(match);
}

/** Whether `channelName` looks like a bot-managed per-match channel (ends in a tag). */
export function isManagedMatchChannelName(channelName: string): boolean {
  return /-vs-.+-[0-9a-f]{6}$/.test(channelName);
}

/** Normalize a team name for the order-insensitive match↔market join. */
function normTeam(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Join a match to its open public market by team pair (order-insensitive).
 *
 * `PublicMarketListItem` exposes no `match_id`, so the team pair is the only
 * public key shared with `/matches/upcoming` — we match `{team1, team2}` as an
 * unordered set. Returns the market or null (no open market yet). Pure.
 */
export function matchMarket(match: UpcomingMatch, markets: readonly PublicMarket[]): PublicMarket | null {
  const want = new Set([normTeam(match.team1), normTeam(match.team2)]);
  for (const m of markets) {
    const have = new Set([normTeam(m.team1), normTeam(m.team2)]);
    if (have.size === want.size && [...want].every((t) => have.has(t))) return m;
  }
  return null;
}

/** Micro-cent YES price → a "NN%" odds string. Pure. */
export function oddsLine(market: PublicMarket): string {
  const pctA = Math.round(market.price_yes / 100);
  const pctB = 100 - pctA;
  return `${market.team1} ${pctA}% · ${market.team2} ${pctB}%`;
}

/**
 * The pinned-message text: matchup + context (event · stage · date/time) +
 * current odds + a **deep link to the match page** (`#matches/<match_id>` — the
 * SPA route that opens the odds chart + trade panel, not the generic markets
 * list). Context lines are omitted when calibre doesn't supply them (e.g. demo
 * replays carry no stage/time). `apiBase` is the calibre base (no trailing
 * slash). Pure.
 */
export function pinnedMessageFor(
  match: UpcomingMatch,
  market: PublicMarket | null,
  apiBase: string,
): string {
  const link = `${apiBase}/#matches/${encodeURIComponent(match.match_id)}`;
  const present = (s?: string): s is string => !!s && s.trim() !== "";
  const lines = [`**${match.team1} vs ${match.team2}**`];
  const stage = [match.event, match.series].filter(present).join(" · ");
  if (stage) lines.push(stage);
  const when = [match.date_group, match.time].filter(present).join(" · ");
  if (when) lines.push(when);
  lines.push(market ? `Current odds: ${oddsLine(market)}` : "No open market yet.");
  lines.push(`Trade on calibre: ${link}`);
  return lines.join("\n");
}

/** The desired per-match channel set for a reconcile pass. */
export interface DesiredChannel {
  match: UpcomingMatch;
  name: string;
  market: PublicMarket | null;
}

/**
 * Build the desired channel set from the upcoming matches + open markets. Only
 * `upcoming`-status matches with both team names get a channel (a TBD/empty
 * matchup has no stable name). Pure.
 */
export function desiredChannels(
  matches: readonly UpcomingMatch[],
  markets: readonly PublicMarket[],
): DesiredChannel[] {
  const out: DesiredChannel[] = [];
  for (const match of matches) {
    if (match.status && match.status !== "upcoming") continue;
    if (!match.team1.trim() || !match.team2.trim()) continue;
    out.push({ match, name: channelNameFor(match), market: matchMarket(match, markets) });
  }
  return out;
}

/** The create/archive diff a reconcile pass should apply. */
export interface ChannelPlan {
  /** Desired channels not yet present — create + pin. */
  create: DesiredChannel[];
  /** Already-present desired channels — refresh the pin. */
  keep: DesiredChannel[];
  /** Managed channel names no longer desired — archive. */
  archive: string[];
}

/**
 * Pure reconcile: given the desired set and the names of the bot's existing
 * managed (non-archived) match channels, decide what to create, keep (refresh),
 * and archive. Idempotent — a desired channel that already exists is kept, not
 * recreated; a managed channel whose match is no longer upcoming is archived.
 */
export function reconcileChannels(
  desired: readonly DesiredChannel[],
  existingManagedNames: readonly string[],
): ChannelPlan {
  const existing = new Set(existingManagedNames);
  const desiredNames = new Set(desired.map((d) => d.name));
  const create = desired.filter((d) => !existing.has(d.name));
  const keep = desired.filter((d) => existing.has(d.name));
  const archive = [...existing].filter((name) => !desiredNames.has(name));
  return { create, keep, archive };
}

/** Fetch the public upcoming matches. Throws on a non-2xx. */
export async function fetchUpcomingMatches(apiBase: string): Promise<UpcomingMatch[]> {
  const res = await fetch(`${apiBase}/api/v1/matches/upcoming`);
  if (!res.ok) throw new Error(`matches/upcoming ${res.status}`);
  const data = (await res.json()) as UpcomingMatch[];
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch the public open-markets listing. Throws on a non-2xx.
 *
 * NOTE: the upstream `GET /api/v1/markets/public/markets` is hard-capped at 12
 * results (the soonest-to-lock open markets). A match whose market isn't in
 * that window won't join here, so `matchMarket` returns null and the channel's
 * pin falls back to "no open market yet" — the channel is still created. To
 * resolve odds for more than 12 concurrent matches, the public endpoint must be
 * widened (or expose `match_id` for a precise join) — tracked calibre-side.
 */
export async function fetchPublicMarkets(apiBase: string): Promise<PublicMarket[]> {
  const res = await fetch(`${apiBase}/api/v1/markets/public/markets`);
  if (!res.ok) throw new Error(`markets/public/markets ${res.status}`);
  const data = (await res.json()) as PublicMarket[];
  return Array.isArray(data) ? data : [];
}
