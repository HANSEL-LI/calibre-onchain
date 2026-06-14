/**
 * Bot configuration — all values from the environment (public env contract in
 * the repo-root `.env.example`; this service ships no secrets).
 *
 * The bot reads RANK from ENS only — the ENS vars below point at an RPC that
 * can resolve `*.<ensParent>` (a chain where the calibre offchain resolver is
 * registered, served by the W6.2 gateway via CCIP-read). The bot never PULLS
 * calibre for rank.
 *
 * As of #580 it also reads calibre's **public** match/market data over HTTP
 * (`calibreApiBase`) to auto-create a channel per upcoming match. That read is
 * public, no-auth — the bot holds no calibre session and never touches a private
 * surface. Ranks still come from ENS only; calibre is the *match-data* source.
 *
 * Identity (#582) arrives the other way: calibre PUSHES the verified
 * `(discord_id -> display_name)` mapping to the bot's ingest server over a
 * SIGNED webhook (`identityWebhookSecret`). The bot maps display_name to
 * `<display_name>.<ensParent>` and resolves rank for it from ENS as before —
 * there is no user-run `/link`.
 */

export interface BotConfig {
  /** Discord bot token (owner-provided; empty placeholder in the env contract). */
  discordToken: string;
  /** Discord application (client) id, for slash-command registration. */
  discordAppId: string;
  /** Guild the bot operates in for the demo. */
  guildId: string;
  /** JSON-RPC endpoint that can resolve ENS names (follows CCIP-read offchain). */
  ensRpcUrl: string;
  /**
   * ENS parent the bot will accept subnames of. `/link` only resolves names
   * ending in `.<ensParent>` so a member can't point the bot at an arbitrary
   * name. Defaults to the calibre parent.
   */
  ensParent: string;
  /** Re-sync interval in milliseconds (periodic role reconcile). */
  resyncIntervalMs: number;
  /** Explicit channel id for promotion shout-outs; if unset the bot ensures a
   * text channel named {@link announceChannelName}. */
  announceChannelId?: string;
  /** Name of the promotion shout-out channel the bot ensures when no id is set. */
  announceChannelName: string;
  /** Name of the rank-gated lounge channel the bot ensures (Seer/Oracle only). */
  loungeChannelName: string;
  /**
   * calibre **public** API base (e.g. `https://app.hicalibre.gg`). The bot reads
   * `GET /api/v1/matches/upcoming` + `GET /api/v1/markets/public/markets` from
   * here (#580) to auto-create a channel per upcoming match. Public, no-auth —
   * the bot holds no session. Trailing slash is stripped so callers append paths.
   */
  calibreApiBase: string;
  /** Name of the Discord category the per-match channels live under. */
  matchCategoryName: string;
  /** Name of the category archived match channels are moved to. */
  matchArchiveCategoryName: string;
  /**
   * Max number of per-match channels to keep — only the next N upcoming matches
   * (in calibre's "next-up" order, demos first) get a channel; the rest are
   * archived (#580). Default 4.
   */
  matchChannelLimit: number;
  /**
   * Max number of those channels that may be demo-replays — demos sort first in
   * calibre's order, so without this cap they'd fill every slot and crowd out
   * real fixtures. The remaining slots go to the soonest real matches. Default 2.
   */
  matchDemoChannelLimit: number;
  /**
   * Shared secret for the verified identity push (#582). calibre HMAC-SHA256-
   * signs the raw webhook body with this; the ingest server verifies it
   * byte-for-byte. When empty the ingest server does not start (the bot still
   * runs role sync for any members already in the registry).
   */
  identityWebhookSecret: string;
  /** TCP port the identity-ingest HTTP server listens on (#582). */
  identityPort: number;
  /**
   * Service token for calibre's `GET /api/v1/markets/{id}/sides` (#581). Sent
   * as `X-Calibre-Markets-Token`; grants the bot read access to the public
   * "which side you're backing" data for the next match. When empty the
   * side-role sync is OFF (the bot still runs rank roles + match channels) —
   * the endpoint is fail-closed calibre-side, so a blank token would only 401.
   */
  marketsServiceToken: string;
  /**
   * What to do with a per-match channel that's no longer in the active set
   * (settled / expired / pushed past the limit). `"archive"` (default) moves it
   * to {@link matchArchiveCategoryName} keeping history; `"delete"` removes it —
   * right for an ephemeral demo guild where cycling demos would otherwise pile
   * up archived channels. A prune is skipped when there are no upcoming matches,
   * so a transient-empty upstream can never wipe every channel.
   */
  matchChannelPruneMode: "archive" | "delete";
}

function req(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const v = env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`missing required env var ${name}`);
  }
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  return {
    discordToken: req(env, "DISCORD_BOT_TOKEN"),
    discordAppId: req(env, "DISCORD_APP_ID"),
    guildId: req(env, "DISCORD_GUILD_ID"),
    // The resolver for hicalibre.eth lives on Ethereum mainnet (rank.ts pins
    // chain: mainnet), so the RPC default must be a mainnet endpoint — a testnet
    // RPC resolves nothing. ENS_PARENT defaults to hicalibre.eth; calibre.eth
    // cannot carry the offchain resolver (ENS briefing §12).
    ensRpcUrl: req(env, "ENS_RPC_URL", "https://cloudflare-eth.com"),
    ensParent: req(env, "ENS_PARENT", "hicalibre.eth").replace(/^\.+|\.+$/g, ""),
    resyncIntervalMs: Number.parseInt(req(env, "RESYNC_INTERVAL_MS", "300000"), 10),
    announceChannelId:
      env.ANNOUNCE_CHANNEL_ID && env.ANNOUNCE_CHANNEL_ID !== "" ? env.ANNOUNCE_CHANNEL_ID : undefined,
    announceChannelName: req(env, "ANNOUNCE_CHANNEL_NAME", "rank-ups"),
    loungeChannelName: req(env, "LOUNGE_CHANNEL_NAME", "oracles-lounge"),
    calibreApiBase: req(env, "CALIBRE_API_BASE", "https://app.hicalibre.gg").replace(/\/+$/, ""),
    matchCategoryName: req(env, "MATCH_CATEGORY_NAME", "upcoming-matches"),
    matchArchiveCategoryName: req(env, "MATCH_ARCHIVE_CATEGORY_NAME", "match-archive"),
    matchChannelLimit: Number.parseInt(req(env, "MATCH_CHANNEL_LIMIT", "4"), 10),
    matchDemoChannelLimit: Number.parseInt(req(env, "MATCH_DEMO_CHANNEL_LIMIT", "2"), 10),
    // Optional: empty secret => ingest server stays off (still no default, so
    // `req` can't be used here — the push is an opt-in surface).
    identityWebhookSecret: env.IDENTITY_WEBHOOK_SECRET ?? "",
    identityPort: Number.parseInt(req(env, "IDENTITY_PORT", "8090"), 10),
    // Optional: empty token => side-role sync stays off (the calibre endpoint
    // is fail-closed, so a blank token would only 401). Opt-in like the push.
    marketsServiceToken: env.MARKETS_SERVICE_TOKEN ?? "",
    matchChannelPruneMode:
      (env.MATCH_CHANNEL_PRUNE_MODE ?? "archive").toLowerCase() === "delete" ? "delete" : "archive",
  };
}
