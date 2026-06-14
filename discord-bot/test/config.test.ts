import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

// Only the three required vars; everything else must fall back to a default.
const MINIMAL: NodeJS.ProcessEnv = {
  DISCORD_BOT_TOKEN: "t",
  DISCORD_APP_ID: "a",
  DISCORD_GUILD_ID: "g",
};

test("ENS defaults resolve against the live setup (hicalibre.eth on mainnet)", () => {
  const cfg = loadConfig(MINIMAL);
  // The resolver lives on Ethereum mainnet and the parent is hicalibre.eth
  // (calibre.eth cannot carry the offchain resolver — ENS briefing §12). A
  // stale default here is the exact silent-no-resolve regression #547 hit.
  assert.equal(cfg.ensParent, "hicalibre.eth");
  assert.equal(cfg.ensRpcUrl, "https://cloudflare-eth.com");
});

test("ENS_PARENT / ENS_RPC_URL still override the defaults", () => {
  const cfg = loadConfig({
    ...MINIMAL,
    ENS_PARENT: "calibre-test.eth",
    ENS_RPC_URL: "https://my.rpc",
  });
  assert.equal(cfg.ensParent, "calibre-test.eth");
  assert.equal(cfg.ensRpcUrl, "https://my.rpc");
});
