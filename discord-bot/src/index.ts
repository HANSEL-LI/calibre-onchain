/**
 * Discord role-sync bot entrypoint (W6.4 / #431; identity ingest #582).
 *
 * Resolves guild members' `<name>.<ensParent>` subnames, reads the
 * `gg.calibre.rank` text record FROM ENS (via a standard viem client following
 * CCIP-read to the W6.2 gateway), and assigns the matching Discord role. RANK
 * is read from ENS only — the bot never PULLS calibre, and never reads anything
 * but the rank record, so roles reveal rank and nothing about open positions.
 *
 * As of #580 it also reads calibre's PUBLIC match/market data over HTTP to
 * auto-create one channel per upcoming match. That read is public, no-auth — no
 * calibre session, no private surface. Ranks stay ENS-sourced; calibre is the
 * match-data source.
 *
 * IDENTITY (which member maps to which name) arrives via calibre's verified,
 * signed push (#582) to the ingest server below — there is no user-run `/link`.
 */
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { createIdentityServer } from "./identity.js";
import { createRankReader } from "./rank.js";

export async function main(): Promise<void> {
  const config = loadConfig();
  const ranks = createRankReader(config.ensRpcUrl, config.ensParent);
  const bot = createBot(config, ranks);

  // Verified identity ingest (#582). Off when no secret is configured (the bot
  // still runs role sync for any members already in the registry).
  if (config.identityWebhookSecret) {
    createIdentityServer({
      secret: config.identityWebhookSecret,
      port: config.identityPort,
      ensParent: config.ensParent,
      onIdentity: (discordId, ensName) => bot.linkMember(discordId, ensName),
    });
    console.log(`identity ingest listening on :${config.identityPort}`);
  } else {
    console.warn("IDENTITY_WEBHOOK_SECRET unset — verified identity ingest disabled");
  }

  await bot.start();
}

// Run when invoked directly (`node dist/index.js`), not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("discord-bot failed to start", err);
    process.exit(1);
  });
}
