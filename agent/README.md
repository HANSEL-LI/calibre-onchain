# calibre_agent

Standalone open-source on-chain **market-maker agent**. It runs unattended from
its own **Dynamic server wallet**, reads calibre's live public market price as
its prior, and trades on the Arc `CalibreMarket` contract.

This is a **new** agent created during the hackathon (ETHGlobal NYC 2026, Seam 4
of the build), **not** a mirror of the private bot fleet: the archetype bodies,
`behavior`, and the PM-anchor stack stay private. On-chain agents are new
pseudonymous personas — addresses, no names — and internal bot identities never
leak (the #224 disclosure invariant).

## What it does (and what it deliberately does not)

- **Its only calibre input is a public read.** Each tick it GETs
  `GET {base}/markets/public/{id}/price` (calibre's W7.1 public endpoint) — the
  live LMSR YES price in micro-cents (`[1, 9999]`, `10000` == probability 1.0).
  There are **no authed calls and no private imports**; this is verifiable from
  this public repo alone.
- **The strategy is intentionally simple.** Fixed size, fixed spread, a hard
  inventory cap, a price band, and a kill-switch. It is a demo maker, not the
  private pricing/anchor stack. The decision each tick:
  1. If the market has **resolved** on-chain and the agent holds winning shares
     → **redeem** (close out, recycle USDC).
  2. Else if the prior is inside the sane band **and** net inventory is under the
     cap → **mint** `size` complete sets, advertising the fixed-spread band
     around the prior.
  3. Otherwise → **hold**.

### On-chain venue: mint / hold / redeem against W1.1

The merged contract is **W1.1** — the custody-independent core (complete-set
`mint`, `transferShares`, `resolve`, `redeem` in USDC). Its EIP-712 voucher
buy/redeem path is **W1.2, not yet merged**. So the agent acts on the real
primitives the contract exposes to any caller today: it **mints complete sets**
(provisioning the two-sided inventory an LMSR maker holds, at the prior),
**holds** under the inventory cap, and **redeems** the winning side once the
market resolves on-chain. When W1.2 lands, the `mint` leg swaps for a
voucher-buy against calibre's signer with **no change to the loop** — only
`contract.MarketClient` gains the voucher call.

## Risk bounds (a bug is bounded by design)

| Bound | Env | Default | Effect |
|---|---|---|---|
| Fixed size | `AGENT_SIZE_SETS` | `1` | complete sets minted per action |
| Inventory cap | `AGENT_INVENTORY_CAP_SETS` | `10` | never mint past this many net sets — caps total USDC at risk |
| Price band | `AGENT_BAND_LO_MICRO` / `AGENT_BAND_HI_MICRO` | `500` / `9500` | skip degenerate near-0 / near-1 priors |
| Spread | `AGENT_SPREAD_MICRO` | `200` | half-spread the maker advertises around the prior |
| Kill-switch | `AGENT_KILL_SWITCH_FILE` | (unset) | if the file exists, the loop halts new actions each tick |
| Demo cap | `AGENT_MAX_ITERATIONS` | `0` (∞) | stop after N ticks |
| Dry run | `AGENT_DRY_RUN` | `true` | log intended actions without sending tx |

`AGENT_DRY_RUN` defaults **on** — flip it to `false` only after the wallet is
funded and you accept the bounded spend. Fund the server wallet with **only** as
much testnet USDC as `inventory_cap_sets * usdcUnit` requires, so a bug can never
exceed it.

## Signer: Dynamic server wallet (with a local-key fallback)

The agent signs from a **Dynamic server wallet** — the Dynamic agentic-bounty
path. When `DYNAMIC_API_KEY` + `DYNAMIC_ENVIRONMENT_ID` are set, it
provisions/loads a server wallet and signs transactions through Dynamic's wallet
API (`calibre_agent.signer.DynamicServerWallet`).

For running against Arc testnet without a Dynamic account, set `AGENT_PRIVATE_KEY`
instead and the agent signs with a local `eth-account` key
(`LocalKeySigner`) — the same primitive the repo's `sdk` uses. Both produce raw
signed bytes, so swapping signers never touches the strategy or loop.

> A real Dynamic environment and a funded Arc testnet server wallet are
> owner/booth-gated. This repo ships only `.env.example` placeholders; supply
> real values in your own environment.

## Run

```bash
cd agent
python -m venv .venv && . .venv/bin/activate
pip install -e .

# minimum env (see repo-root .env.example for the full contract):
export AGENT_MARKET_ID=42
export CALIBRE_PUBLIC_API_BASE=https://app.hicalibre.gg/api/v1
export ARC_RPC_URL=https://rpc.testnet.arc.network
export ARC_CHAIN_ID=5042002
export CALIBRE_MARKET_ADDRESS=0x...        # deployed CalibreMarket
export ARC_USDC_ADDRESS=0x...              # 6-decimal ERC-20 USDC on Arc
# pick a signer:
export DYNAMIC_API_KEY=...  DYNAMIC_ENVIRONMENT_ID=...   # server wallet (bounty)
# or, for a testnet dry run without Dynamic:
export AGENT_PRIVATE_KEY=0x...

python -m calibre_agent            # or: calibre-agent
```

By default it polls every 15s in dry-run; set `AGENT_DRY_RUN=false` to trade.

## Test

```bash
cd agent && pip install -e ".[test]" && python -m pytest tests/
```

23 offline tests (no network, no chain) cover the band gate, inventory cap,
redeem-on-resolve, dry-run, kill-switch, max-iterations, config-from-env, and the
price-feed status handling.

## Chain params (Arc testnet)

| Field | Value |
|---|---|
| chainId | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |
| USDC | ERC-20 interface is **6-decimal** (native gas token is 18-decimal — the contract reads `usdcUnit` from `usdc.decimals()`, so the agent never hardcodes the scale) |
