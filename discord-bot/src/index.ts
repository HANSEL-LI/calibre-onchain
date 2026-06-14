/**
 * Discord role-sync bot entrypoint (W6.4 / #431).
 *
 * Resolves guild members' `<name>.calibre.eth` subnames, reads the
 * `gg.calibre.rank` text record FROM ENS (via a standard viem client following
 * CCIP-read to the W6.2 gateway), and assigns the matching Discord role. Ranks
 * come from ENS only — never anything but the rank record, so roles reveal rank
 * and nothing about open positions.
 *
 * As of #580 it also reads calibre's PUBLIC match/market data over HTTP to
 * auto-create one channel per upcoming match. That read is public, no-auth — no
 * calibre session, no private surface. Ranks stay ENS-sourced; calibre is the
 * match-data source.
 */
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { createRankReader } from "./rank.js";

export function main(): Promise<void> {
  const config = loadConfig();
  const ranks = createRankReader(config.ensRpcUrl, config.ensParent);
  const bot = createBot(config, ranks);
  return bot.start();
}

// Run when invoked directly (`node dist/index.js`), not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("discord-bot failed to start", err);
    process.exit(1);
  });
}
