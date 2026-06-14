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
import {
  type ClanClient,
  type ProfileClient,
  addrRecord,
  clanTextRecord,
  isClanRecordKey,
  textRecord,
} from "./profile.js";

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
 * resolves the *user* leaf exactly as the flat form does. A bare 3-label name
 * (`sharks.calibre.eth`) is **ambiguous** — it is the user-lookup candidate here
 * AND a possible clan (see `bareClanLabelFor`); `handleResolve` tries the user
 * first so a real user always resolves as a user (#583).
 *
 * Returns null for the bare parent (`calibre.eth`) — nothing to resolve.
 */
export function displayNameFor(name: string): string | null {
  const labels = name.split(".").filter((l) => l.length > 0);
  if (labels.length <= 2) return null; // bare "calibre.eth" or shorter
  return labels[0];
}

/**
 * The clan label a name resolves to as a **clan-aggregate** profile, or null.
 *
 * Only a bare single-label clan name — exactly `<clan>.<parent>.<tld>` (3 labels,
 * e.g. `sharks.hicalibre.eth`) — is a clan candidate. A nested
 * `<user>.<clan>.calibre.eth` (≥4 labels) is always a user leaf (the `<clan>` is
 * namespacing, not a lookup), and the bare parent (≤2 labels) is nothing. The
 * clan candidate is the SAME leftmost label `displayNameFor` returns for a
 * 3-label name, so the two coincide exactly where disambiguation is needed;
 * `handleResolve` resolves the tie user-first (#583, F4).
 */
export function bareClanLabelFor(name: string): string | null {
  const labels = name.split(".").filter((l) => l.length > 0);
  if (labels.length !== 3) return null;
  return labels[0];
}

export interface ResolveResult {
  /**
   * The `bytes` return value of ENSIP-10 `resolve()`: the inner record call's
   * return type ABI-encoded *directly* (`abi.encode(address|bytes|string)`) — NOT
   * re-wrapped in an outer `bytes`. The client (UniversalResolver / viem) decodes
   * this straight as the inner function's result, so an extra wrap would
   * double-encode it (addr → an ABI offset, text → a length-prefixed blob).
   */
  result: Hex;
}

/** A `ClanClient` whose every fetch returns null — the default when no clan
 * lookup is wired (keeps clan resolution opt-in and existing call-sites valid). */
const NO_CLAN_CLIENT: ClanClient = { async fetch() { return null; } };

/**
 * Answer a CCIP-read `resolve(name, data)` request against the profile API.
 * Unknown subnames / unset records resolve to the empty value (0-address / "")
 * — indistinguishable from "never set", so there is no enumeration oracle.
 *
 * Disambiguation for a bare `<clan>.hicalibre.eth` (#583): the leftmost label is
 * tried as a **user** first, so a real user name always resolves as a user. Only
 * when no such user exists do we serve clan-aggregate text records
 * (`gg.calibre.clan.*`) from the clan endpoint. Nested `<user>.<clan>...` names
 * are never clans. `addr()` is a user-only record, so a clan-only name resolves
 * `addr()` to the zero address.
 */
export async function handleResolve(
  callData: Hex,
  profiles: ProfileClient,
  clans: ClanClient = NO_CLAN_CLIENT,
): Promise<ResolveResult> {
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
        return { result: encodeAbiParameters([{ type: "address" }], [addr]) };
      }
      // addr(node, coinType): non-ETH or unset → empty bytes.
      const bytesAddr: Hex = valid ? (getAddress(raw).toLowerCase() as Hex) : "0x";
      return { result: encodeAbiParameters([{ type: "bytes" }], [bytesAddr]) };
    }
    case "text": {
      const key = inner.args[1] as string;
      let value = profile ? textRecord(profile, key) : "";
      // Clan fallback: a bare clan name with no matching user, queried for a
      // clan-aggregate key, resolves the clan profile. User-first (profile !==
      // null short-circuits this) keeps a real user resolving as a user (#583).
      if (!profile && isClanRecordKey(key)) {
        const clanLabel = bareClanLabelFor(name);
        const clan = clanLabel ? await clans.fetch(clanLabel) : null;
        value = clan ? clanTextRecord(clan, key) : "";
      }
      return { result: encodeAbiParameters([{ type: "string" }], [value]) };
    }
    default:
      // Unsupported record type → empty bytes (resolver returns nothing).
      return { result: "0x" };
  }
}
