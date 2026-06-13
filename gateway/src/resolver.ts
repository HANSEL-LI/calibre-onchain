/**
 * CCIP-read (ENSIP-10) resolve dispatch.
 *
 * The on-chain wildcard resolver reverts `OffchainLookup` with calldata that is
 * an ABI-encoded `IExtendedResolver.resolve(bytes name, bytes data)` call:
 *   - `name` is the DNS-wire-encoded ENS name (e.g. demo.calibre.eth)
 *   - `data` is the inner resolver call the client actually wants:
 *       addr(bytes32 node)            0x3b3b57de
 *       addr(bytes32 node, uint256)   0xf1cb7e06  (coinType; we serve 60 = ETH)
 *       text(bytes32 node, string key) 0x59d1d43c
 *
 * We decode the inner call, parse the leftmost label as the calibre
 * `display_name`, fetch the profile, and ABI-encode the answer the inner call's
 * return type expects (address / bytes / string). The encoded answer is then
 * signed (see signing.ts) for the EIP-3668 callback.
 */
import {
  type Hex,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  isAddress,
  parseAbi,
} from "viem";
import { type ProfileClient, addrRecord, textRecord } from "./profile.js";

// ENSIP-10 extended resolver entrypoint + the record functions we serve.
const RESOLVE_ABI = parseAbi(["function resolve(bytes name, bytes data) view returns (bytes)"]);
const RECORD_ABI = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
]);

const ETH_COIN_TYPE = 60n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Decode a DNS-wire-encoded name (ENSIP-10) into dot-joined labels. */
export function decodeDnsName(encoded: Hex): string {
  const bytes = Buffer.from(encoded.slice(2), "hex");
  const labels: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i];
    if (len === 0) break;
    labels.push(bytes.subarray(i + 1, i + 1 + len).toString("utf8"));
    i += 1 + len;
  }
  return labels.join(".");
}

/**
 * The calibre display_name a subname resolves to: always the **leftmost** label.
 *
 *   demo.calibre.eth          → "demo"   (flat user subname)
 *   demo.sharks.calibre.eth   → "demo"   (clan-nested, W6.3 / overview F4)
 *
 * Clan nesting (`<user>.<clan>.calibre.eth`) is an addressing convenience: the
 * `<clan>` label is namespacing, not a second DB lookup, so a nested name
 * resolves the *user* leaf exactly as the flat form does. A bare clan name
 * (`sharks.calibre.eth`) is structurally identical to a flat user subname, so it
 * is looked up as a user — there is no clan-aggregate profile endpoint in Seam 2
 * this weekend, so a non-profile clan label simply yields the empty record (no
 * enumeration oracle, same as any unknown name). The clan-membership cross-check
 * is a W6.4 concern once a clan endpoint exists.
 *
 * Returns null for the bare parent (`calibre.eth`) — nothing to resolve.
 */
export function displayNameFor(name: string): string | null {
  const labels = name.split(".").filter((l) => l.length > 0);
  if (labels.length <= 2) return null; // bare "calibre.eth" or shorter
  return labels[0];
}

export interface ResolveResult {
  /** ABI-encoded answer for the inner record call (wrapped for resolve()'s bytes return). */
  result: Hex;
}

/**
 * Answer a CCIP-read `resolve(name, data)` request against the profile API.
 * Unknown subnames / unset records resolve to the empty value (0-address / "")
 * — indistinguishable from "never set", so there is no enumeration oracle.
 */
export async function handleResolve(callData: Hex, profiles: ProfileClient): Promise<ResolveResult> {
  const { functionName, args } = decodeFunctionData({ abi: RESOLVE_ABI, data: callData });
  if (functionName !== "resolve") {
    throw new Error(`unexpected outer call ${functionName}`);
  }
  const [dnsName, innerData] = args as [Hex, Hex];
  const name = decodeDnsName(dnsName);
  const displayName = displayNameFor(name);

  const inner = decodeFunctionData({ abi: RECORD_ABI, data: innerData });
  const profile = displayName ? await profiles.fetch(displayName) : null;

  switch (inner.functionName) {
    case "addr": {
      // addr(node) returns address; addr(node, coinType) returns bytes.
      const wantsCoinType = inner.args.length === 2;
      const coinType = wantsCoinType ? (inner.args[1] as bigint) : ETH_COIN_TYPE;
      const raw = profile ? addrRecord(profile) : "";
      // Accept non-checksummed addresses (the DB may store lowercase); getAddress
      // normalizes below. coinType != 60 (non-ETH) is unset for this gateway.
      const valid = !!raw && isAddress(raw, { strict: false }) && coinType === ETH_COIN_TYPE;

      if (!wantsCoinType) {
        const addr = valid ? getAddress(raw) : ZERO_ADDRESS;
        return { result: wrap(encodeAbiParameters([{ type: "address" }], [addr])) };
      }
      // addr(node, coinType): non-ETH or unset → empty bytes.
      const bytesAddr: Hex = valid ? (getAddress(raw).toLowerCase() as Hex) : "0x";
      return { result: wrap(encodeAbiParameters([{ type: "bytes" }], [bytesAddr])) };
    }
    case "text": {
      const key = inner.args[1] as string;
      const value = profile ? textRecord(profile, key) : "";
      return { result: wrap(encodeAbiParameters([{ type: "string" }], [value])) };
    }
    default:
      // Unsupported record type → empty bytes (resolver returns nothing).
      return { result: wrap("0x") };
  }
}

/** Wrap an inner answer as the `bytes` return value of `resolve(...)`. */
function wrap(inner: Hex): Hex {
  return encodeAbiParameters([{ type: "bytes" }], [inner]);
}
