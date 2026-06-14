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
