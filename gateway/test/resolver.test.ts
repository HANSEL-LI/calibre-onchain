import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Hex,
  decodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  toHex,
} from "viem";
import type { ProfileClient, PublicProfile } from "../src/profile.js";
import { decodeDnsName, displayNameFor, handleResolve } from "../src/resolver.js";

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
  wallet_address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  discord_handle: "demo#1234",
  riot_id: "Demo#NA1",
  clan: "sharks",
};

function stubClient(byName: Record<string, PublicProfile>): ProfileClient {
  return {
    async fetch(displayName: string) {
      return byName[displayName] ?? null;
    },
  };
}

function unwrapText(result: Hex): string {
  const [inner] = decodeAbiParameters([{ type: "bytes" }], result) as [Hex];
  const [value] = decodeAbiParameters([{ type: "string" }], inner) as [string];
  return value;
}

function unwrapAddr(result: Hex): string {
  const [inner] = decodeAbiParameters([{ type: "bytes" }], result) as [Hex];
  const [addr] = decodeAbiParameters([{ type: "address" }], inner) as [string];
  return addr;
}

test("decodeDnsName round-trips a subname", () => {
  assert.equal(decodeDnsName(dnsEncode("demo.calibre.eth")), "demo.calibre.eth");
});

test("displayNameFor takes the leftmost label, null for the bare parent", () => {
  assert.equal(displayNameFor("demo.calibre.eth"), "demo");
  assert.equal(displayNameFor("calibre.eth"), null);
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
