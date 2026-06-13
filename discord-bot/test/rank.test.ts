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

test("rejects clan-nested names (W6.3 degrade — top-level only)", () => {
  // <user>.<clan>.calibre.eth needs subnames (#430); degrade gracefully.
  assert.equal(isAcceptedName("alice.team.calibre.eth", PARENT), false);
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
