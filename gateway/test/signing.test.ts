import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Address,
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  recoverAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeSignatureHash, signResult } from "../src/signing.js";

// Deterministic anvil test key #0 — testnet only, never a real key.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const TARGET = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const REQUEST = "0xdeadbeef" as Hex;

test("signResult produces a tuple a viem client can verify against the signed hash", async () => {
  const result = encodeAbiParameters([{ type: "string" }], ["diamond"]) as Hex;
  const { data, expires } = await signResult(KEY, TARGET, REQUEST, result, 300);

  const [decodedResult, decodedExpires, sig] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }],
    data,
  ) as [Hex, bigint, Hex];

  assert.equal(decodedResult, result);
  assert.equal(decodedExpires, expires);

  // Recompute the exact signed hash and recover the signer — must be our key.
  const hash = makeSignatureHash(TARGET, expires, REQUEST, result);
  const recovered = await recoverAddress({ hash, signature: sig });
  assert.equal(recovered, privateKeyToAccount(KEY).address);
});

test("expires is in the future and bounded by the ttl", async () => {
  const now = Math.floor(Date.now() / 1000);
  const { expires } = await signResult(KEY, TARGET, REQUEST, "0x", 120);
  assert.ok(expires > BigInt(now));
  assert.ok(expires <= BigInt(now + 121));
});
