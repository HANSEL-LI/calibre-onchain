# `@calibre-onchain/parity` — bot ↔ gateway resolution-contract harness

The Discord bot (`discord-bot/`) and the ENS CCIP-read gateway (`gateway/`) are
**independently deployed** but share one resolution contract:

> the bot accepts a name (`isAcceptedName`) **iff** the gateway resolves it to a
> non-empty user leaf (`displayNameFor`).

Each package has its own `npm test`. Nothing inside either package runs *both*
predicates against a single case table, so a future "simplification" of either
side could silently desync the bot's accept set from what the gateway serves
while both per-package suites stay green (#553).

This package is that committed parity check. It imports the **real**
`isAcceptedName` and `displayNameFor` and asserts they agree across one shared
case table — flat, clan-nested, deeper-nested, bare-clan, bare-parent, empty
labels (leading/doubled/trailing dots), foreign suffixes, case/whitespace, and a
foreign parent. It **fails red** if the two ever disagree.

The only harness-side code is `gatewayResolvesUserLeaf`, which models the
deployment topology (the gateway only receives names under the parent, already
normalized) around the real `displayNameFor`. See the test header for why.

## Run

```sh
cd parity && npm install && npm test
```

The repo has no CI workflow file today; when one lands, add this command as a
test step alongside the per-package `npm test` runs.
