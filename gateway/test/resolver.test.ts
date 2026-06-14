import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Hex,
  decodeAbiParameters,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  toHex,
} from "viem";
import type { ClanClient, ClanProfile, ProfileClient, PublicProfile } from "../src/profile.js";
import {
  bareClanLabelFor,
  decodeDnsName,
  displayNameFor,
  handleResolve,
} from "../src/resolver.js";

const RESOLVE_ABI = parseAbi(["function resolve(bytes name, bytes data) view returns (bytes)"]);
const RECORD_ABI = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
]);

const NODE = "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;

/** DNS-wire-encode an ENS name (length-prefixed labels, null-terminated). */
function dnsEncode(name: string): Hex {
  const parts = name.split(".");
  const out: number[] = [];
  for (const label of parts) {
    const bytes = Buffer.from(label, "utf8");
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
  return toHex(Uint8Array.from(out));
}

function resolveCall(name: string, inner: Hex): Hex {
  return encodeFunctionData({ abi: RESOLVE_ABI, functionName: "resolve", args: [dnsEncode(name), inner] });
}

const DEMO: PublicProfile = {
  display_name: "demo",
  tier: "diamond",
  brier_skill: 0.42,
  roi: 1.5,
  pnl: 12345,
  win_rate: 0.6,
  n_resolved: 5,
  streak: 2,
  wallet_address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  discord_handle: "demo#1234",
  riot_id: "Demo#NA1",
  clan: "sharks",
  avatar: "https://app.hicalibre.gg/api/v1/profiles/demo/avatar.svg",
  url: "https://app.hicalibre.gg/#profile/demo",
  description: "Calibre forecaster — diamond",
};

function stubClient(byName: Record<string, PublicProfile>): ProfileClient {
  return {
    async fetch(displayName: string) {
      return byName[displayName] ?? null;
    },
  };
}

function stubClanClient(byClan: Record<string, ClanProfile>): ClanClient {
  return {
    async fetch(clan: string) {
      return byClan[clan] ?? null;
    },
  };
}

const SHARKS_CLAN: ClanProfile = {
  clan: "sharks",
  size: 7,
  avg_rank: "Edge",
  brier_skill: 0.31,
  median_brier_skill: 0.28,
  roi: 0.42,
  top_member: "demo",
};

// `result` is the `bytes` return of ENSIP-10 resolve() — the inner record call's
// return type ABI-encoded *directly*. A real client decodes it as that type with
// no extra unwrap; the on-chain resolveWithProof→UniversalResolver layer supplies
// the single `bytes` peel for free.
function unwrapText(result: Hex): string {
  const [value] = decodeAbiParameters([{ type: "string" }], result) as [string];
  return value;
}

function unwrapAddr(result: Hex): string {
  const [addr] = decodeAbiParameters([{ type: "address" }], result) as [string];
  return addr;
}

test("decodeDnsName round-trips a subname", () => {
  assert.equal(decodeDnsName(dnsEncode("demo.calibre.eth")), "demo.calibre.eth");
});

test("displayNameFor takes the leftmost label, null for the bare parent", () => {
  assert.equal(displayNameFor("demo.calibre.eth"), "demo");
  assert.equal(displayNameFor("calibre.eth"), null);
});

test("displayNameFor resolves clan-nested <user>.<clan>.calibre.eth to the user leaf", () => {
  // W6.3 / F4: the <clan> label is namespacing, not a second lookup — the
  // leftmost label is still the calibre display_name.
  assert.equal(displayNameFor("demo.sharks.calibre.eth"), "demo");
  // A bare clan name is structurally a flat user subname → looked up as a user.
  assert.equal(displayNameFor("sharks.calibre.eth"), "sharks");
});

test("decodeDnsName round-trips a clan-nested subname", () => {
  assert.equal(
    decodeDnsName(dnsEncode("demo.sharks.calibre.eth")),
    "demo.sharks.calibre.eth",
  );
});

test("text(gg.calibre.rank) on a clan-nested name resolves the user's tier", async () => {
  const inner = encodeFunctionData({
    abi: RECORD_ABI,
    functionName: "text",
    args: [NODE, "gg.calibre.rank"],
  });
  const { result } = await handleResolve(
    resolveCall("demo.sharks.calibre.eth", inner),
    stubClient({ demo: DEMO }),
  );
  assert.equal(unwrapText(result), "diamond");
});

test("gg.calibre.clan resolves the user's clan on a clan-nested name", async () => {
  const inner = encodeFunctionData({
    abi: RECORD_ABI,
    functionName: "text",
    args: [NODE, "gg.calibre.clan"],
  });
  const { result } = await handleResolve(
    resolveCall("demo.sharks.calibre.eth", inner),
    stubClient({ demo: DEMO }),
  );
  assert.equal(unwrapText(result), "sharks");
});

test("unknown user under a clan resolves to empty (no enumeration oracle)", async () => {
  const empty = stubClient({}); // every fetch -> null
  const inner = encodeFunctionData({
    abi: RECORD_ABI,
    functionName: "text",
    args: [NODE, "gg.calibre.rank"],
  });
  const { result } = await handleResolve(resolveCall("ghost.sharks.calibre.eth", inner), empty);
  assert.equal(unwrapText(result), "");
});

test("addr(node) returns the wallet address for an opted-in profile", async () => {
  const inner = encodeFunctionData({ abi: RECORD_ABI, functionName: "addr", args: [NODE] });
  const { result } = await handleResolve(resolveCall("demo.calibre.eth", inner), stubClient({ demo: DEMO }));
  assert.equal(unwrapAddr(result).toLowerCase(), DEMO.wallet_address!.toLowerCase());
});

test("text(gg.calibre.rank) returns the tier", async () => {
  const inner = encodeFunctionData({
    abi: RECORD_ABI,
    functionName: "text",
    args: [NODE, "gg.calibre.rank"],
  });
  const { result } = await handleResolve(resolveCall("demo.calibre.eth", inner), stubClient({ demo: DEMO }));
  assert.equal(unwrapText(result), "diamond");
});

test("text(com.discord) and gg.calibre.roi map through", async () => {
  const client = stubClient({ demo: DEMO });
  const discord = encodeFunctionData({ abi: RECORD_ABI, functionName: "text", args: [NODE, "com.discord"] });
  const roi = encodeFunctionData({ abi: RECORD_ABI, functionName: "text", args: [NODE, "gg.calibre.roi"] });
  assert.equal(
    unwrapText((await handleResolve(resolveCall("demo.calibre.eth", discord), client)).result),
    "demo#1234",
  );
  assert.equal(
    unwrapText((await handleResolve(resolveCall("demo.calibre.eth", roi), client)).result),
    "1.5",
  );
});

test("unknown / not-opted-in subname resolves to empty (no leak)", async () => {
  const empty = stubClient({}); // every fetch -> null (the API's indistinguishable 404)
  const addrInner = encodeFunctionData({ abi: RECORD_ABI, functionName: "addr", args: [NODE] });
  const textInner = encodeFunctionData({
    abi: RECORD_ABI,
    functionName: "text",
    args: [NODE, "gg.calibre.rank"],
  });
  const addrRes = await handleResolve(resolveCall("ghost.calibre.eth", addrInner), empty);
  const textRes = await handleResolve(resolveCall("ghost.calibre.eth", textInner), empty);
  assert.equal(unwrapAddr(addrRes.result), "0x0000000000000000000000000000000000000000");
  assert.equal(unwrapText(textRes.result), "");
});

test("unset record on an opted-in profile resolves to empty", async () => {
  const noLinks: PublicProfile = { ...DEMO, discord_handle: null, riot_id: null, clan: null };
  const inner = encodeFunctionData({ abi: RECORD_ABI, functionName: "text", args: [NODE, "com.discord"] });
  const { result } = await handleResolve(
    resolveCall("demo.calibre.eth", inner),
    stubClient({ demo: noLinks }),
  );
  assert.equal(unwrapText(result), "");
});

test("addr() result decodes the way a real ENS client does (no extra wrap)", async () => {
  // A real ENS client treats resolve()'s declared `bytes` return as addr()'s
  // ABI-encoded result and decodes it directly — there is no second `bytes` layer
  // to peel. `result` IS that bytes value, so decodeFunctionResult(addr, result)
  // must yield the wallet address. (A double-wrap would surface as an ABI offset.)
  const inner = encodeFunctionData({ abi: RECORD_ABI, functionName: "addr", args: [NODE] });
  const { result } = await handleResolve(resolveCall("demo.calibre.eth", inner), stubClient({ demo: DEMO }));
  const addr = decodeFunctionResult({ abi: RECORD_ABI, functionName: "addr", data: result });
  assert.equal(String(addr).toLowerCase(), DEMO.wallet_address!.toLowerCase());
});

// ── Clan-aggregate records on a bare <clan>.hicalibre.eth (#583) ──

test("bareClanLabelFor: only a 3-label name is a clan candidate", () => {
  assert.equal(bareClanLabelFor("sharks.calibre.eth"), "sharks"); // bare clan
  assert.equal(bareClanLabelFor("demo.sharks.calibre.eth"), null); // nested → user leaf
  assert.equal(bareClanLabelFor("calibre.eth"), null); // bare parent
});

test("bare clan name with no matching user resolves clan-aggregate records", async () => {
  const clanInner = encodeFunctionData({
    abi: RECORD_ABI,
    functionName: "text",
    args: [NODE, "gg.calibre.clan.brier"],
  });
  // No user "sharks" exists; the clan endpoint knows the clan.
  const { result } = await handleResolve(
    resolveCall("sharks.calibre.eth", clanInner),
    stubClient({}),
    stubClanClient({ sharks: SHARKS_CLAN }),
  );
  assert.equal(unwrapText(result), "0.31");
});

test("clan size / avgrank / brier / median / roi / top map through", async () => {
  const clans = stubClanClient({ sharks: SHARKS_CLAN });
  const key = (k: string) =>
    encodeFunctionData({ abi: RECORD_ABI, functionName: "text", args: [NODE, k] });
  const resolveKey = async (k: string) =>
    unwrapText(
      (await handleResolve(resolveCall("sharks.calibre.eth", key(k)), stubClient({}), clans)).result,
    );
  assert.equal(await resolveKey("gg.calibre.clan.size"), "7");
  assert.equal(await resolveKey("gg.calibre.clan.avgrank"), "Edge");
  assert.equal(await resolveKey("gg.calibre.clan.brier"), "0.31");
  assert.equal(await resolveKey("gg.calibre.clan.median"), "0.28");
  assert.equal(await resolveKey("gg.calibre.clan.roi"), "0.42");
  assert.equal(await resolveKey("gg.calibre.clan.top"), "demo");
});

test("clan top/median on an unscored clan resolve to empty (no oracle)", async () => {
  // A clan with no scored members: top_member/median/brier/roi are null → "".
  const unscored: ClanProfile = {
    ...SHARKS_CLAN,
    brier_skill: null,
    median_brier_skill: null,
    roi: null,
    top_member: null,
  };
  const clans = stubClanClient({ sharks: unscored });
  const key = (k: string) =>
    encodeFunctionData({ abi: RECORD_ABI, functionName: "text", args: [NODE, k] });
  const resolveKey = async (k: string) =>
    unwrapText(
      (await handleResolve(resolveCall("sharks.calibre.eth", key(k)), stubClient({}), clans)).result,
    );
  assert.equal(await resolveKey("gg.calibre.clan.top"), "");
  assert.equal(await resolveKey("gg.calibre.clan.median"), "");
  // size stays populated for an unscored-but-existing clan.
  assert.equal(await resolveKey("gg.calibre.clan.size"), "7");
});

test("a real user wins over a same-label clan (user-first disambiguation)", async () => {
  // Both a user "sharks" and a clan "sharks" exist. A user-record key resolves
  // the user; the clan client is never consulted for the user's own records.
  const userSharks: PublicProfile = { ...DEMO, display_name: "sharks", tier: "Sharp" };
  const rankInner = encodeFunctionData({
    abi: RECORD_ABI,
    functionName: "text",
    args: [NODE, "gg.calibre.rank"],
  });
  const { result } = await handleResolve(
    resolveCall("sharks.calibre.eth", rankInner),
    stubClient({ sharks: userSharks }),
    stubClanClient({ sharks: SHARKS_CLAN }),
  );
  assert.equal(unwrapText(result), "Sharp");
});

test("clan key on a nested name does not trigger clan lookup", async () => {
  // demo.sharks.calibre.eth is a user leaf; a clan-aggregate key has no user
  // value and must NOT fall through to the clan endpoint.
  const clanInner = encodeFunctionData({
    abi: RECORD_ABI,
    functionName: "text",
    args: [NODE, "gg.calibre.clan.size"],
  });
  const { result } = await handleResolve(
    resolveCall("demo.sharks.calibre.eth", clanInner),
    stubClient({ demo: DEMO }),
    stubClanClient({ sharks: SHARKS_CLAN }),
  );
  assert.equal(unwrapText(result), "");
});

test("unknown bare clan resolves to empty (no enumeration oracle)", async () => {
  const clanInner = encodeFunctionData({
    abi: RECORD_ABI,
    functionName: "text",
    args: [NODE, "gg.calibre.clan.brier"],
  });
  const { result } = await handleResolve(
    resolveCall("ghosts.calibre.eth", clanInner),
    stubClient({}),
    stubClanClient({}),
  );
  assert.equal(unwrapText(result), "");
});

test("addr() on a clan-only name is the zero address (clans have no wallet)", async () => {
  const inner = encodeFunctionData({ abi: RECORD_ABI, functionName: "addr", args: [NODE] });
  const { result } = await handleResolve(
    resolveCall("sharks.calibre.eth", inner),
    stubClient({}),
    stubClanClient({ sharks: SHARKS_CLAN }),
  );
  assert.equal(unwrapAddr(result), "0x0000000000000000000000000000000000000000");
});
