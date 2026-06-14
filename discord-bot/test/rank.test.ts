import assert from "node:assert/strict";
import { test } from "node:test";
import { RANK_TEXT_KEY, createRankReader, isAcceptedName } from "../src/rank.js";
import type { EnsClient } from "../src/rank.js";

const PARENT = "calibre.eth";

test("rank text key is the canonical gg.calibre.rank", () => {
  assert.equal(RANK_TEXT_KEY, "gg.calibre.rank");
});

test("accepts a top-level subname of the parent", () => {
  assert.equal(isAcceptedName("demo.calibre.eth", PARENT), true);
  assert.equal(isAcceptedName("DEMO.calibre.eth", PARENT), true); // case-insensitive
  assert.equal(isAcceptedName("  alice.calibre.eth ", PARENT), true); // trims
});

test("rejects the bare parent and foreign suffixes", () => {
  assert.equal(isAcceptedName("calibre.eth", PARENT), false);
  assert.equal(isAcceptedName("demo.eth", PARENT), false);
  assert.equal(isAcceptedName("demo.example.eth", PARENT), false);
  assert.equal(isAcceptedName("", PARENT), false);
});

test("accepts clan-nested <user>.<clan>.parent names (leftmost label = user)", () => {
  // #550: lift the top-level-only restriction. <user>.<clan>.calibre.eth now
  // resolves the leftmost label (the user) — matching the gateway's
  // displayNameFor. The <clan> label is namespacing, not a second lookup.
  assert.equal(isAcceptedName("alice.team.calibre.eth", PARENT), true);
  assert.equal(isAcceptedName("alice.sharks.calibre.eth", PARENT), true);
  // Deeper nesting is still just a leftmost-label resolution.
  assert.equal(isAcceptedName("alice.squad.sharks.calibre.eth", PARENT), true);
  // Case-insensitive + trims, same as the flat form.
  assert.equal(isAcceptedName("  Alice.Sharks.calibre.eth ", PARENT), true);
});

test("empty labels are dropped before counting (matches displayNameFor)", () => {
  // The gateway's displayNameFor filters empty labels, so a leading/doubled dot
  // is not a distinct label: ".sharks.calibre.eth" cleans to sharks.calibre.eth
  // (leaf "sharks") and resolves — the bot must accept the same set.
  assert.equal(isAcceptedName(".sharks.calibre.eth", PARENT), true);
  assert.equal(isAcceptedName("alice..sharks.calibre.eth", PARENT), true);
  // But a name that cleans down to just the bare parent has no user leaf.
  assert.equal(isAcceptedName(".calibre.eth", PARENT), false);
  assert.equal(isAcceptedName("calibre..eth", PARENT), false);
});

test("isAcceptedName parent is configurable (hicalibre.eth)", () => {
  // The live parent is hicalibre.eth; the accept logic is parent-agnostic and
  // must work identically for the flat and clan-nested forms.
  const HI = "hicalibre.eth";
  assert.equal(isAcceptedName("alice.hicalibre.eth", HI), true);
  assert.equal(isAcceptedName("alice.sharks.hicalibre.eth", HI), true);
  assert.equal(isAcceptedName("hicalibre.eth", HI), false);
  assert.equal(isAcceptedName("alice.calibre.eth", HI), false); // foreign parent
});

function stubClient(records: Record<string, string>): EnsClient {
  return {
    async getEnsText({ name, key }) {
      return records[`${name}|${key}`] ?? "";
    },
  };
}

test("rankReader reads only the rank key and returns the tier", async () => {
  const reader = createRankReader(
    "http://unused",
    PARENT,
    stubClient({ "demo.calibre.eth|gg.calibre.rank": "Seer" }),
  );
  assert.equal(await reader.rankOf("demo.calibre.eth"), "Seer");
});

test("rankReader resolves a clan-nested name to the user's tier", async () => {
  // Success criterion: alice.sharks.calibre.eth returns the same tier as
  // alice.calibre.eth. The bot forwards the full name to the ENS client; viem's
  // CCIP-read drives the gateway, which extracts the leftmost label (the user)
  // and serves that profile's rank — so a clan-nested name reads alice's record.
  const reader = createRankReader(
    "http://unused",
    PARENT,
    stubClient({
      "alice.calibre.eth|gg.calibre.rank": "Oracle",
      "alice.sharks.calibre.eth|gg.calibre.rank": "Oracle",
    }),
  );
  const flat = await reader.rankOf("alice.calibre.eth");
  const nested = await reader.rankOf("alice.sharks.calibre.eth");
  assert.equal(nested, "Oracle");
  assert.equal(nested, flat, "clan-nested name resolves the same tier as the flat user name");
});

test("rankReader forwards the full clan-nested name to the ENS client", async () => {
  // The leftmost-label extraction lives in the gateway (displayNameFor); the bot
  // must hand it the *full* normalized name unchanged so the contract boundary
  // stays on the gateway side. Confirm we don't pre-trim labels client-side.
  const seenNames: string[] = [];
  const client: EnsClient = {
    async getEnsText({ name }) {
      seenNames.push(name);
      return "Sharp";
    },
  };
  const reader = createRankReader("http://unused", PARENT, client);
  await reader.rankOf("alice.sharks.calibre.eth");
  assert.deepEqual(seenNames, ["alice.sharks.calibre.eth"]);
});

test("rankReader returns null for an unset record", async () => {
  const reader = createRankReader("http://unused", PARENT, stubClient({}));
  assert.equal(await reader.rankOf("nobody.calibre.eth"), null);
});

test("clanOf reads the gg.calibre.clan label (trimmed); null when unset", async () => {
  const reader = createRankReader(
    "http://unused",
    PARENT,
    stubClient({ "alice.calibre.eth|gg.calibre.clan": "  Sharks  " }),
  );
  assert.equal(await reader.clanOf("alice.calibre.eth"), "Sharks");
  assert.equal(await reader.clanOf("nobody.calibre.eth"), null);
});

test("cardOf reads rank+roi+brier for the ephemeral self-view", async () => {
  const reader = createRankReader(
    "http://unused",
    PARENT,
    stubClient({
      "demo.calibre.eth|gg.calibre.rank": "Seer",
      "demo.calibre.eth|gg.calibre.roi": "0.42",
      "demo.calibre.eth|gg.calibre.brier": "0.58",
    }),
  );
  assert.deepEqual(await reader.cardOf("demo.calibre.eth"), {
    rank: "Seer",
    roi: "0.42",
    brier: "0.58",
  });
});

test("cardOf returns null for an unaccepted name; unset fields become null", async () => {
  const reader = createRankReader(
    "http://unused",
    PARENT,
    stubClient({ "x.calibre.eth|gg.calibre.rank": "Edge" }),
  );
  assert.equal(await reader.cardOf("foreign.eth"), null);
  assert.deepEqual(await reader.cardOf("x.calibre.eth"), { rank: "Edge", roi: null, brier: null });
});

test("rankReader returns null (no resolve) for an unaccepted name", async () => {
  let called = false;
  const client: EnsClient = {
    async getEnsText() {
      called = true;
      return "Oracle";
    },
  };
  const reader = createRankReader("http://unused", PARENT, client);
  assert.equal(await reader.rankOf("foreign.eth"), null);
  assert.equal(called, false, "must not resolve an unaccepted name");
});

test("rankReader never requests roi/brier/position keys (privacy)", async () => {
  const seenKeys: string[] = [];
  const client: EnsClient = {
    async getEnsText({ key }) {
      seenKeys.push(key);
      return "Edge";
    },
  };
  const reader = createRankReader("http://unused", PARENT, client);
  await reader.rankOf("priv.calibre.eth");
  assert.deepEqual(seenKeys, ["gg.calibre.rank"]);
});

// Live regression for the bug where the default client used a bare chain with no
// UniversalResolver, so every real resolution threw "Chain does not support
// contract ensUniversalResolver" — invisible to the stubbed tests above. This
// builds the *real* viem-backed reader (no clientOverride) and resolves a name
// over mainnet → CCIP-read → gateway. Network-gated (off by default, like the
// calibre @llm tests): run with `ENS_LIVE_TEST=1 [ENS_RPC_URL=...] npm test`.
test(
  "rankReader resolves a real name over mainnet (no bare-chain regression)",
  { skip: !process.env.ENS_LIVE_TEST },
  async () => {
    const rpc = process.env.ENS_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
    const parent = process.env.ENS_PARENT ?? "hicalibre.eth";
    const name = process.env.ENS_LIVE_NAME ?? `calibre.${parent}`;
    const reader = createRankReader(rpc, parent);
    const tier = await reader.rankOf(name);
    assert.ok(typeof tier === "string" && tier.length > 0, `expected a tier for ${name}, got ${tier}`);
  },
);
