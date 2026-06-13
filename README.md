# calibre-onchain

Calibre on-chain: the open-source feature built at **ETHGlobal NYC 2026**
(Continuity track). It takes calibre's prediction-markets stack on-chain — an
**Arc / USDC** settlement contract, an **ENS** CCIP-read resolver gateway, a
Discord rank-sync bot, a portable ranking lib, a standalone market-maker agent,
and the thin SDK the **private calibre app** imports.

This repository develops **APIs / services / contracts only — there is no
frontend here.** All user-facing UI lives in the private calibre app, which
consumes these packages (Python SDK import) and services (HTTP).

> Status: **W0 scaffold** — package skeleton + working Foundry toolchain.
> Implementation lands in follow-up sub-issues (W1.x, W6.2–W6.4, W7.2).

## Architecture intent

calibre runs an internal, points-denominated LMSR prediction market. For the
Continuity weekend, a subset of markets gain on-chain mirrors that settle in
USDC on Arc. Users onboard via Dynamic embedded wallets, fund via Blink, and
carry a portable forecasting reputation over ENS subnames. The private app keeps
running on points; this repo is the public, judge-readable on-chain surface.

Custody model: **A-lite** — LMSR stays off-chain; the chain handles
mint / resolve / redeem with calibre as the standing EIP-712 counterparty.

## Package map

| Package | Contents | Language |
|---|---|---|
| [`contracts/`](contracts/) | `CalibreMarket.sol` — complete-set mint / trade-transfer / resolve / redeem in USDC; deploy scripts; tests | Solidity (Foundry) |
| [`gateway/`](gateway/) | ENS CCIP-read (ENSIP-10) resolver gateway for `*.calibre.eth` — serves `addr()` + `text()` from the calibre public profile API, incl. clan-nested `<user>.<clan>.calibre.eth` | TypeScript |
| [`discord-bot/`](discord-bot/) | Role-sync bot: resolve members' subnames → read `gg.calibre.rank` → assign Discord role | TypeScript |
| [`ranking/`](ranking/) | Pure rank-bucketing lib (skill percentile → tier, the F5 `Static…Oracle` ladder) + the canonical `gg.calibre.*` text-record key schema | Python |
| [`agent/`](agent/) | Standalone on-chain market-maker agent: Dynamic server wallet + calibre public price feed as its prior, quoting on the Arc contract | Python |
| [`sdk/`](sdk/) | `calibre_onchain` pip package the private app imports: contract client (create / resolve), tx-signing helpers | Python |

## Public / private boundary contract

This is the line the whole split is organized around — **read it before adding
anything here.**

- **The contract ABI and the SDK see `(chain_market_id, outcome)` only.** They
  carry **no** LMSR state, points balances, ledger entries, matching internals,
  or bot internals across the boundary. The SDK's settlement inputs are a market
  id and a winning outcome — nothing more.
- **The public services (`gateway/`, `discord-bot/`, `agent/`) never touch the
  database.** Their sole data source is calibre's **public-tier HTTP API**: a
  read-only profile endpoint (rank / identity / wallet for opted-in humans) and
  a price feed for chain-mirrored markets. They never see email, `user_id`,
  `is_bot`, open positions, or open orders.
- **Dependency direction is one-way:**

  ```
  private calibre ──imports──► sdk/, ranking/          (public code, no secrets)
  gateway/, discord-bot/, agent/ ──HTTP──► calibre public API   (profile + price feed)
  private calibre ──signs──► CalibreMarket.sol on Arc  (resolver key)
  ```

  Public components never import private code. Private code imports the public
  packages (safe — MIT, dependency-light, reviewed in the open).

### What stays private (never in this repo)

The LMSR engine, the matching engine, settlement internals, the bot fleet
(behavior + archetypes + dispatcher), the VLR / Liquipedia scrapers, the
Polymarket collector/anchor stack, the admin surface, and all deploy/infra.

## How the private app consumes this repo

- **SDK (`calibre_onchain`)** — imported as a pip dependency. On a successful
  off-chain points resolve, the private app's settlement hook calls
  `sdk.create_market(...)` / `sdk.resolve(chain_market_id, outcome)`, signed by
  the backend resolver key. The call is post-commit, off the hot path, and
  never-raise: a failed chain call logs and retries next lifecycle tick — it
  never blocks or rolls back points settlement.
- **`ranking/`** — imported directly so the private app computes tiers with the
  exact bucketing code the judges can read, and emits the canonical
  `gg.calibre.*` text-record keys the gateway expects.
- **Services (`gateway/`, `discord-bot/`, `agent/`)** — run standalone and pull
  from calibre's public API over HTTP; the private app exposes that API but does
  not import the services.

## Toolchains

- `contracts/` — [Foundry](https://book.getfoundry.sh/) (`forge build`, `forge test`).
- `gateway/`, `discord-bot/` — Node.js + TypeScript.
- `ranking/`, `agent/`, `sdk/` — Python 3.12+ (each pip-installable).

Copy `.env.example` to `.env` and fill in testnet values to run the services
standalone. The example file ships placeholders only — never commit real keys.

## Arc deployment (`CalibreMarket.sol`)

The settlement core (W1.1) deploys to **Arc testnet** (chainId **5042002**, RPC
`https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`,
faucet `https://faucet.circle.com`). USDC accounting goes through the **6-decimal
ERC-20** interface — Arc's native 18-decimal USDC gas asset is never touched.

```bash
cd contracts
export USDC_ADDRESS=0x...          # 6-dec ERC-20 USDC on Arc testnet
export RESOLVER_ADDRESS=0x...      # initial resolver (throwaway weekend key)
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.testnet.arc.network --broadcast
```

| Field | Value |
|---|---|
| Network | Arc testnet (chainId 5042002) |
| `CalibreMarket` address | _TBD — recorded by the owner/booth-gated live Arc run_ |
| Deploy tx | _TBD — live Arc run_ |

## End-to-end settlement proof (W1.3, #423) — the Saturday-noon custody checkpoint

`script/EndToEnd.s.sol` is the umbrella's **custody checkpoint**: a broadcastable
`forge script` (not a unit test) that sends real transactions for the entire
A-lite round-trip and `require`s every invariant, so the run itself is the
pass/fail signal. **Green ⇒ custody stays Model A-lite; a red run degrades W2.3
(#427) and W3.1 (#424) to Model B.**

It exercises: `deploy(usdc, resolver)` → `createMarket` + `setVoucherSigner` +
`setCounterparty` → `seedInventory` (counterparty fronts USDC for complete sets)
→ `buy(quote, sig)` with an **off-chain EIP-712 voucher** and `msg.sender ==
buyer` (one YES buy + one NO buy) → `resolve(YES)` → `redeem` winners 1:1 (buyer
+ counterparty residual) → assert final USDC balances and **drain-to-zero
solvency**.

### Canonical run — local anvil (deterministic, no funding)

```bash
cd contracts
# terminal A — a local chain
anvil
# terminal B — broadcast the full round-trip against it
forge script script/EndToEnd.s.sol:EndToEnd \
  --rpc-url http://127.0.0.1:8545 --broadcast -vvv
```

Local mode deploys `MockUSDC` (6-decimal, mirrors the Arc USDC ERC-20 interface)
and mints to the three deterministic actors, so no faucet is needed. The script's
actor keys (resolver/counterparty/buyer) start with zero ETH on a fresh anvil; if
the broadcast errors with *insufficient funds for gas*, fund them once via the
addresses the script logs:

```bash
for A in <resolver> <counterparty> <buyer>; do
  cast rpc anvil_setBalance "$A" 0xDE0B6B3A7640000 --rpc-url http://127.0.0.1:8545
done
```

A successful run ends with `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.` and logs
`== PASS: A-lite e2e round-trip solvent, drained to zero ==`.

### Same script vs live Arc testnet (owner/booth-gated — do NOT run unattended)

Set the real token + a funded broadcaster; nothing else changes:

```bash
export USDC_ADDRESS=0x...        # real 6-dec ERC-20 USDC on Arc testnet (faucet: faucet.circle.com)
forge script script/EndToEnd.s.sol:EndToEnd \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $FUNDED_KEY --broadcast -vvv
```

Live mode skips the MockUSDC deploy + mint (binds the env token and expects the
funded key to already hold USDC). Per the W8 spike §3, only Arc's RPC reproduces
Arc-specific transfer reverts (blocklist/precompile, native-vs-ERC20 decimals);
the local run proves the settlement *logic*, the live run is the final
Arc-environment confirmation.

### Checkpoint verdict

**PASS (custody stays Model A-lite).** Verified on a local anvil chain on
2026-06-12: all 15 broadcast transactions mined successfully and the contract's
USDC balance drained to exactly `0` after every winner redeemed. Independent
`cast` reads confirmed final balances (buyer +30 USDC net on its 30 winning
shares, counterparty made whole on its residual inventory, market backing `0`,
total USDC conserved). The 28 existing `forge test` cases stay green.

## License

[MIT](LICENSE).
