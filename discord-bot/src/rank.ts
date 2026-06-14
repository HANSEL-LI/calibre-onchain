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
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";

// Canonical rank text-record key. Mirrors `calibre_ranking.RANK_KEY` /
// `gateway` `gg.calibre.rank` — the one record this bot is allowed to read.
export const RANK_TEXT_KEY = "gg.calibre.rank" as const;
export const ROI_TEXT_KEY = "gg.calibre.roi" as const;
export const BRIER_TEXT_KEY = "gg.calibre.brier" as const;

/**
 * The fields shown in the ephemeral `/link` card. ROI + Brier are read ONLY for
 * this self-view (the linking member seeing their own public profile) — the
 * Discord-role derivation stays rank-only ({@link RankReader.rankOf}) so a
 * member's *roles* never leak trading activity.
 */
export interface ProfileCard {
  rank: string | null;
  roi: string | null;
  brier: string | null;
}

/**
 * Whether `name` is a subname of `parent` whose **leftmost label** we resolve.
 *
 * Accepts any name ending in `.<parent>` with a label before the parent — both
 * the flat user form `<user>.<parent>` and the clan-nested form
 * `<user>.<clan>.<parent>` (and deeper). In every case the resolved leaf is the
 * leftmost label (the user); the intermediate `<clan>` labels are namespacing,
 * not a second lookup. (Clan-nesting was stubbed behind #430; #550 lifts the
 * top-level-only restriction.)
 *
 * This is a resolution-contract boundary: a name is accepted here **iff** the
 * gateway's {@link displayNameFor} would resolve it to a non-empty user leaf,
 * computed by the *same* steps — lowercase, drop empty labels, require >2
 * remaining labels, and require the (cleaned) name to end in the parent. Keeping
 * the label-cleaning identical (empty labels dropped before counting) is what
 * makes the bot accept exactly the set of names the gateway serves; a leading or
 * doubled dot must not flip the two apart. Pure — no network.
 */
export function isAcceptedName(name: string, parent: string): boolean {
  const lparent = parent.trim().toLowerCase();
  // Mirror displayNameFor: split, drop empty labels (a leading/doubled dot is
  // not a distinct label), then require the cleaned name to be a subname of the
  // parent with at least one label (the user) in front of it.
  const labels = name.trim().toLowerCase().split(".").filter((l) => l.length > 0);
  const parentLabels = lparent.split(".").filter((l) => l.length > 0);
  // Need a user leaf plus the parent labels: strictly more labels than parent.
  if (labels.length <= parentLabels.length) return false;
  // The trailing labels must be exactly the parent (foreign suffixes rejected).
  const suffix = labels.slice(labels.length - parentLabels.length);
  if (suffix.join(".") !== parentLabels.join(".")) return false;
  return true;
}

export interface RankReader {
  /**
   * Resolve `name`'s `gg.calibre.rank` text record. Returns the tier string, or
   * null if the name is unaccepted / unset / unresolvable (never throws on a
   * normal miss — an unset record resolves to "").
   */
  rankOf(name: string): Promise<string | null>;
  /**
   * Read the public profile card (rank + roi + brier) for an accepted name, for
   * the ephemeral `/link` reply. Returns null only for an unaccepted name; an
   * accepted name with no records resolves every field to null. See
   * {@link ProfileCard} for the privacy scoping.
   */
  cardOf(name: string): Promise<ProfileCard | null>;
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
      // ENS resolution needs the chain's UniversalResolver contract address:
      // viem's getEnsText looks it up on `chain.contracts.ensUniversalResolver`
      // and throws "Chain does not support contract ensUniversalResolver" for a
      // bare chain. The calibre offchain resolver for the parent name is
      // registered on Ethereum mainnet (Arc has no ENS registry), so name
      // resolution always goes through mainnet's UniversalResolver, which then
      // follows the EIP-3668 CCIP-read revert to the gateway. The RPC endpoint is
      // still operator-configurable via `rpcUrl` (point it at a mainnet RPC).
      chain: mainnet,
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
    async cardOf(name: string): Promise<ProfileCard | null> {
      if (!isAcceptedName(name, parent)) return null;
      const normalized = normalize(name);
      const clean = (v: string | null | undefined): string | null =>
        v === null || v === undefined || v === "" ? null : v;
      const [rank, roi, brier] = await Promise.all([
        client.getEnsText({ name: normalized, key: RANK_TEXT_KEY }),
        client.getEnsText({ name: normalized, key: ROI_TEXT_KEY }),
        client.getEnsText({ name: normalized, key: BRIER_TEXT_KEY }),
      ]);
      return { rank: clean(rank), roi: clean(roi), brier: clean(brier) };
    },
  };
}
