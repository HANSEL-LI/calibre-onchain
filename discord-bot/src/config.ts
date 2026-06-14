/**
 * Bot configuration — all values from the environment (public env contract in
 * the repo-root `.env.example`; this service ships no secrets).
 *
 * The bot reads ENS only. The ENS-related vars below point at an RPC that can
 * resolve `*.calibre.eth` (i.e. a chain where the calibre offchain resolver is
 * registered, served by the W6.2 gateway via CCIP-read). There is deliberately
 * NO calibre-API base here — the bot never calls calibre.
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
    ensRpcUrl: req(env, "ENS_RPC_URL", "https://sepolia.gateway.tenderly.co"),
    ensParent: req(env, "ENS_PARENT", "calibre.eth").replace(/^\.+|\.+$/g, ""),
    resyncIntervalMs: Number.parseInt(req(env, "RESYNC_INTERVAL_MS", "300000"), 10),
    announceChannelId:
      env.ANNOUNCE_CHANNEL_ID && env.ANNOUNCE_CHANNEL_ID !== "" ? env.ANNOUNCE_CHANNEL_ID : undefined,
    announceChannelName: req(env, "ANNOUNCE_CHANNEL_NAME", "rank-ups"),
    loungeChannelName: req(env, "LOUNGE_CHANNEL_NAME", "oracles-lounge"),
  };
}
