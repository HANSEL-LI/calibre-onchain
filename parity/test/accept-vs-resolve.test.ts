/**
 * Cross-package parity harness (#553).
 *
 * The Discord bot and the ENS gateway are independently-deployed services that
 * share a resolution contract: **the bot accepts a name iff the gateway resolves
 * it to a non-empty user leaf.** #550 made them agree across the cross-product of
 * name shapes, but verified it out-of-band — both packages have separate
 * `npm test` suites and nothing committed runs *both* predicates against one
 * case table. A future "simplification" of either side (e.g. dropping
 * `displayNameFor`'s empty-label filter, or `isAcceptedName`'s suffix check)
 * could silently desync the bot's accept set from what the gateway serves while
 * both per-package suites stay green. This harness fails red on that drift.
 *
 * Both predicates here are the **real** functions, imported from their packages:
 *   - bot side:     `isAcceptedName`  (discord-bot/src/rank.ts)
 *   - gateway side: `displayNameFor`  (gateway/src/resolver.ts)
 *
 * The only harness-side code is `gatewayResolvesUserLeaf`, a thin wrapper that
 * models the *deployment topology* around `displayNameFor` — not its logic:
 *
 *   1. `displayNameFor` does NOT check the parent suffix; it returns the leftmost
 *      label whenever there are >2 non-empty labels. The real gateway only ever
 *      *receives* names under the parent, because the on-chain offchain-resolver
 *      is registered only on `hicalibre.eth` and the CCIP-read path routes
 *      nothing else to it. So a faithful gateway predicate restricts to names
 *      under the parent before consulting `displayNameFor`.
 *   2. `displayNameFor` does not lowercase/trim; viem normalizes the name before
 *      DNS-encoding, so the gateway receives an already-normalized name. The
 *      wrapper applies the same trim+lowercase the bot's `isAcceptedName` applies,
 *      mirroring what reaches the gateway in practice.
 *
 * If the topology changes (e.g. the resolver is registered on a second parent),
 * revisit the suffix restriction below.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAcceptedName } from "../../discord-bot/src/rank.js";
import { displayNameFor } from "../../gateway/src/resolver.js";

/**
 * Does the gateway resolve `name` to a non-empty user leaf, given it only ever
 * receives names under `parent` (see module header)? Wraps the **real**
 * `displayNameFor` with the deployment-topology restriction + normalization.
 */
function gatewayResolvesUserLeaf(name: string, parent: string): boolean {
  // (2) Normalization the real path applies before the gateway sees the name.
  const norm = name.trim().toLowerCase();
  const lparent = parent.trim().toLowerCase();
  // (1) Topology restriction: only names under the parent reach this gateway.
  const labels = norm.split(".").filter((l) => l.length > 0);
  const parentLabels = lparent.split(".").filter((l) => l.length > 0);
  if (labels.length < parentLabels.length) return false;
  const suffix = labels.slice(labels.length - parentLabels.length);
  if (suffix.join(".") !== parentLabels.join(".")) return false;
  // Real gateway leftmost-label resolution. Non-empty leaf == "resolvable".
  const leaf = displayNameFor(norm);
  return leaf !== null && leaf !== "";
}

interface Case {
  name: string;
  parent: string;
  /** The contract verdict: accepted by the bot == resolvable by the gateway. */
  accepted: boolean;
  why: string;
}

const PARENT = "hicalibre.eth";

// One shared case table exercised by BOTH predicates. Covers every name shape
// the contract spans (#553 scope): flat, clan-nested, deeper nesting, bare clan,
// the bare parent, empty labels (leading/doubled/trailing dots), foreign
// suffixes, case/whitespace variants, and a foreign parent.
const CASES: Case[] = [
  // ── Resolvable: a non-empty leftmost user leaf under the parent ──
  { name: "demo.hicalibre.eth", parent: PARENT, accepted: true, why: "flat <user>.<parent>" },
  { name: "alice.sharks.hicalibre.eth", parent: PARENT, accepted: true, why: "clan-nested <user>.<clan>.<parent>" },
  { name: "alice.squad.sharks.hicalibre.eth", parent: PARENT, accepted: true, why: "deeper nesting, still leftmost-label" },
  { name: "sharks.hicalibre.eth", parent: PARENT, accepted: true, why: "bare clan (3-label) is structurally a user leaf" },
  { name: ".demo.hicalibre.eth", parent: PARENT, accepted: true, why: "leading dot → empty label dropped" },
  { name: "alice..sharks.hicalibre.eth", parent: PARENT, accepted: true, why: "doubled dot → empty label dropped" },
  { name: "demo.hicalibre.eth.", parent: PARENT, accepted: true, why: "trailing dot → empty label dropped" },
  { name: "DEMO.hicalibre.eth", parent: PARENT, accepted: true, why: "uppercase normalizes to a valid leaf" },
  { name: "  alice.hicalibre.eth ", parent: PARENT, accepted: true, why: "surrounding whitespace trimmed" },

  // ── Not resolvable: no user leaf, or not under the parent ──
  { name: "hicalibre.eth", parent: PARENT, accepted: false, why: "bare parent — nothing to resolve" },
  { name: "", parent: PARENT, accepted: false, why: "empty string" },
  { name: ".hicalibre.eth", parent: PARENT, accepted: false, why: "cleans down to the bare parent" },
  { name: "hicalibre..eth", parent: PARENT, accepted: false, why: "doubled dot inside the parent → still bare parent" },
  { name: "demo.eth", parent: PARENT, accepted: false, why: "foreign suffix (no parent)" },
  { name: "demo.example.eth", parent: PARENT, accepted: false, why: "foreign suffix (wrong parent)" },
  { name: "demo.hicalibre.gg", parent: PARENT, accepted: false, why: "foreign TLD" },

  // ── Parent-agnostic: a different configured parent ──
  { name: "alice.calibre.eth", parent: "calibre.eth", accepted: true, why: "flat user under an alternate parent" },
  { name: "alice.sharks.calibre.eth", parent: "calibre.eth", accepted: true, why: "clan-nested under an alternate parent" },
  { name: "calibre.eth", parent: "calibre.eth", accepted: false, why: "bare alternate parent" },
  { name: "alice.hicalibre.eth", parent: "calibre.eth", accepted: false, why: "foreign parent for this config" },
];

// Guard against a vacuous pass: a wrapper or predicate stuck on one value would
// still match a single-outcome table. Require both verdicts to be exercised.
test("the parity case table is non-degenerate (exercises both verdicts)", () => {
  assert.ok(CASES.some((c) => c.accepted), "table must contain an accepted case");
  assert.ok(CASES.some((c) => !c.accepted), "table must contain a rejected case");
});

// The load-bearing check: for every case, the bot's accept verdict and the
// gateway's resolvable-leaf verdict MUST agree, and both must match the contract
// verdict in the table. A drift on either side fails this red.
for (const c of CASES) {
  test(`parity — ${c.why} [${JSON.stringify(c.name)} @ ${c.parent}]`, () => {
    const botAccepts = isAcceptedName(c.name, c.parent);
    const gatewayResolves = gatewayResolvesUserLeaf(c.name, c.parent);
    assert.equal(
      botAccepts,
      gatewayResolves,
      `bot/gateway desync: isAcceptedName=${botAccepts} but gateway resolvable=${gatewayResolves}`,
    );
    assert.equal(botAccepts, c.accepted, `contract verdict mismatch for ${JSON.stringify(c.name)}`);
  });
}
