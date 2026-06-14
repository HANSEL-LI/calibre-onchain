# #553 — ENS cross-package parity harness (bot accept-set vs gateway resolvable-set)

Tracking issue: `HANSEL-LI/Calibre#553` (P3, hardening). Follow-up to #550
(calibre-onchain PR #21), which made the Discord bot's `isAcceptedName`
(`discord-bot/src/rank.ts`) and the gateway's leftmost-label resolution
(`gateway/src/resolver.ts` `displayNameFor`) agree across 36 cross-product cases
verified **out-of-band**. There is no committed executable check that runs both
predicates against a shared case table, so a future "simplification" of either
could silently desync them while both per-package suites stay green.

This issue adds that committed parity check. It does **not** refactor either
predicate (parsimony) — it only locks the contract.

## The contract under test

The boundary is: **the bot accepts a name iff the gateway resolves it to a
non-empty user leaf.** Stated as predicates:

- **Bot side (real fn):** `isAcceptedName(name, parent)` — trims, lowercases,
  drops empty labels, requires strictly more labels than the parent, and requires
  the trailing labels to equal the parent exactly.
- **Gateway side:** the gateway's resolvable-leaf is `displayNameFor(name)`
  returning a non-empty leftmost label. Two modelling facts make this a faithful
  predicate rather than a raw `displayNameFor` call:
  1. `displayNameFor` does **not** check the parent suffix — it takes the leftmost
     label whenever `labels.length > 2`. The real gateway only ever *receives*
     names under the parent, because the on-chain offchain-resolver is registered
     only on `hicalibre.eth`; the CCIP-read path routes nothing else to it. So the
     faithful gateway predicate restricts to names under the parent.
  2. `displayNameFor` does not lowercase/trim; viem normalizes the name before
     DNS-encoding, so the gateway receives an already-normalized name. The model
     applies the same trim+lowercase before calling the real `displayNameFor`.

The harness asserts, for every case in one shared table:
`isAcceptedName(name, parent) === gatewayResolvesUserLeaf(name, parent)` where
`gatewayResolvesUserLeaf` is a thin, documented wrapper that models the
deployment topology (suffix restriction + normalization) around the **real**
`displayNameFor`. Both predicates are the real, imported functions — only the
topology wrapper is harness code.

## Decision — harness home (records the §6 choice)

A top-level `parity/` package with its own `package.json` + `tsconfig` and its own
`npm test`, importing both real functions by relative path.

Why not a shared fixture imported into an existing package's `test/`: both
packages set `rootDir` (`src`, and `.` in the test config) and a cross-package
import (`../../discord-bot/src/rank.js` from `gateway/test`) fails
`tsc --noEmit -p tsconfig.test.json` with TS6059 ("not under rootDir") — verified.
tsx *runs* it, but the typecheck gate in each package's `test` script rejects it,
so the harness cannot live inside either package without weakening that package's
typecheck. A top-level package sidesteps the per-package rootDir entirely and is
the "top-level test step" the issue explicitly allows. It also keeps both
packages' suites untouched (parsimony).

## Files to touch

- `parity/package.json` — new. `"type": "module"`, `test` script mirroring the
  other packages (`tsc --noEmit -p tsconfig.json && node --test --import tsx ...`),
  `tsx` + `typescript` + `@types/node` + `viem` devDeps (rank.ts imports viem types
  at module load; needed for the typecheck and at runtime).
- `parity/tsconfig.json` — new. No `rootDir`; includes the parity sources plus the
  two real source files it imports, so the typecheck spans both packages without a
  rootDir conflict.
- `parity/test/accept-vs-resolve.test.ts` — new. The shared case table + the parity
  assertion (real `isAcceptedName` vs the topology-wrapped real `displayNameFor`),
  plus a self-check that the wrapper itself is non-trivial (table covers both
  accept and reject outcomes) so a wrapper that always returns the same value can't
  pass vacuously.
- `parity/README.md` — new, short. Why the harness exists, how to run it, that it
  must fail red on drift.
- `docs/DEMO-SCRIPT.md` / `docs/ARCHITECTURE.md` — left untouched (no behaviour
  change to demo).

## Shared case table — coverage

Parent fixed at `hicalibre.eth` (live parent; also a `calibre.eth` row to confirm
parent-agnosticism). Cases (name, expected-accepted):
- flat `<user>.<parent>` → accept
- clan-nested `<user>.<clan>.<parent>` → accept
- deeper `<user>.<a>.<b>.<parent>` → accept
- bare clan `<clan>.<parent>` (3-label) → accept (structurally a user leaf)
- bare parent `<parent>` → reject
- empty string → reject
- leading dot `.<user>.<parent>` → accept (empty label dropped)
- doubled dot `<user>..<parent>` → accept
- trailing dot `<user>.<parent>.` → accept
- name cleaning to bare parent (`.<parent>`, `<p0>..<tld>`) → reject
- foreign suffix `<user>.eth`, `<user>.example.eth` → reject
- case/whitespace variants (`DEMO.<parent>`, `  alice.<parent> `) → accept
- foreign parent under a different configured parent → reject

## Named commit phases

1. `docs(plans): #553 parity-harness plan` — this file.
2. `test(parity): top-level bot/gateway accept-vs-resolve parity harness` —
   the `parity/` package (package.json, tsconfig, the test, README).

## Risks

- **False parity via a buggy wrapper.** Mitigated by the table covering both
  accept and reject outcomes and a guard asserting the table is non-degenerate
  (≥1 accept and ≥1 reject), so a wrapper stuck on one value fails.
- **Drift in the topology model.** If the deployment topology changes (e.g. the
  resolver gets registered on a second parent), the wrapper's suffix restriction
  must be revisited. Documented inline.
- **Third install/test step.** The loop's test commands cover both packages; the
  parity step is run explicitly here and documented in `parity/README.md`. Not
  wired into CI config because the repo has no CI workflow file today; the README
  records the command so it joins whatever CI lands.

## Test command

```
cd parity && npm install && npm test
# plus the unchanged per-package suites:
cd ../discord-bot && npm install && npm test
cd ../gateway && npm install && npm test
```
