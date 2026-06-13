/**
 * Read a member's calibre rank FROM ENS.
 *
 * This is the load-bearing "roles-from-ENS" leg: the bot resolves a
 * `<name>.calibre.eth` name's `gg.calibre.rank` text record using a STANDARD
 * ENS client (viem). viem follows ENSIP-10 wildcard resolution and the
 * EIP-3668 CCIP-read `OffchainLookup` revert transparently to the W6.2 gateway
 * — so the bot reads ENS exactly like any third party would, with **zero
 * calibre-API calls**. The only egress is the JSON-RPC endpoint and whatever
 * CCIP gateway the resolver points it at.
 *
 * Privacy: the bot reads ONLY the rank record. It never requests
 * `gg.calibre.roi`, `gg.calibre.brier`, or any position/P&L data — those are
 * not rank, and roles must not leak trading activity.
 */
import { type Chain, createPublicClient, http } from "viem";
import { normalize } from "viem/ens";

// Canonical rank text-record key. Mirrors `calibre_ranking.RANK_KEY` /
// `gateway` `gg.calibre.rank` — the one record this bot is allowed to read.
export const RANK_TEXT_KEY = "gg.calibre.rank" as const;

/**
 * Whether `name` is a top-level subname of `parent` we will resolve.
 *
 * Accepts exactly `<label>.<parent>` (one label under the parent). Clan-nested
 * names (`<user>.<clan>.calibre.eth`) need W6.3 (#430); until then we degrade
 * gracefully and resolve top-level names only. Rejects the bare parent, foreign
 * suffixes, and empty labels. Pure — no network.
 */
export function isAcceptedName(name: string, parent: string): boolean {
  const lname = name.trim().toLowerCase();
  const lparent = parent.trim().toLowerCase();
  if (!lname.endsWith("." + lparent)) return false;
  const head = lname.slice(0, lname.length - lparent.length - 1);
  if (head.length === 0) return false;
  // Exactly one label under the parent (no further dots) — top-level only.
  if (head.includes(".")) return false;
  return true;
}

export interface RankReader {
  /**
   * Resolve `name`'s `gg.calibre.rank` text record. Returns the tier string, or
   * null if the name is unaccepted / unset / unresolvable (never throws on a
   * normal miss — an unset record resolves to "").
   */
  rankOf(name: string): Promise<string | null>;
}

export interface EnsClient {
  getEnsText(args: { name: string; key: string }): Promise<string | null>;
}

/**
 * A {@link RankReader} backed by a viem public client over `rpcUrl`.
 * `parent` gates which names are accepted. `clientOverride` is injectable for
 * tests so the pure read path can be exercised without a live RPC.
 */
export function createRankReader(
  rpcUrl: string,
  parent: string,
  clientOverride?: EnsClient,
): RankReader {
  const client: EnsClient =
    clientOverride ??
    (createPublicClient({
      // Chain id/name are not load-bearing for ENS text resolution; the RPC
      // endpoint determines the network. A minimal chain shape keeps viem happy.
      chain: { id: 0, name: "ens", nativeCurrency: { name: "", symbol: "", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as Chain,
      transport: http(rpcUrl),
    }) as unknown as EnsClient);

  return {
    async rankOf(name: string): Promise<string | null> {
      if (!isAcceptedName(name, parent)) return null;
      const normalized = normalize(name);
      const value = await client.getEnsText({ name: normalized, key: RANK_TEXT_KEY });
      if (value === null || value === undefined || value === "") return null;
      return value;
    },
  };
}
