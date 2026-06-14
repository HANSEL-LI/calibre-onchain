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
     cap → **buy** `size` YES shares at the prior via a W1.2 voucher, advertising
     the fixed-spread band around the prior.
  3. Otherwise → **hold**.

### On-chain venue: voucher-buy / hold / redeem (W1.2)

The contract is `CalibreMarket.sol` — the W1.1 custody-independent core plus the
merged **W1.2 (#422)** EIP-712 voucher extension. The agent's making leg is the
**voucher buy** (#444): each tick, under the band + cap, it buys the YES side at
the prior by submitting a **calibre-signed** EIP-712 voucher to
`buy(quote, sig)` (the contract charges the signed `quote.maxCost`; #465),
**holds** under the inventory cap, and **redeems** the
winning side once the market resolves on-chain. (The W1.1 complete-set `mint` is
retained on `MarketClient` as a primitive but is no longer the making venue.)

The agent is the **buyer** (`msg.sender == quote.buyer`); the voucher is signed by
calibre's `voucherSigner` key — a *different* trust surface from the agent's own
tx-signing identity. So the agent **obtains** a signed voucher via a
`voucher.VoucherSource` and submits it under its own key:

- **`CalibreVoucherClient`** — the production path: fetches an LMSR-priced,
  backend-signed voucher from calibre's quote endpoint (W3.1). Selected when
  `CALIBRE_VOUCHER_API_BASE` is set.
- **`LocalVoucherSigner`** — an offline/testnet fallback that signs the voucher
  locally with `AGENT_VOUCHER_SIGNER_KEY` against `CalibreMarket`'s frozen EIP-712
  domain + `Quote` struct, so the artifact buys end-to-end with no calibre
  backend. Selected when only `AGENT_VOUCHER_SIGNER_KEY` is set.

> The agent's EIP-712 digest is verified byte-for-byte against `CalibreMarket.hashQuote`
> in `tests/test_voucher.py` (`test_digest_matches_contract_hashquote`) — the
> field order / domain must match the contract exactly or a buy reverts on-chain.

## Risk bounds (a bug is bounded by design)

| Bound | Env | Default | Effect |
|---|---|---|---|
| Fixed size | `AGENT_SIZE_SETS` | `1` | shares bought per action |
| Inventory cap | `AGENT_INVENTORY_CAP_SETS` | `10` | never buy past this many net sets — caps total USDC at risk |
| Price band | `AGENT_BAND_LO_MICRO` / `AGENT_BAND_HI_MICRO` | `500` / `9500` | skip degenerate near-0 / near-1 priors |
| Spread | `AGENT_SPREAD_MICRO` | `200` | half-spread the maker advertises around the prior |
| Kill-switch | `AGENT_KILL_SWITCH_FILE` | (unset) | if the file exists, the loop halts new actions each tick (also written by the MPC policy-violation webhook, #619) |
| MPC policy | Dynamic dashboard + `DYNAMIC_WEBHOOK_SECRET` | (unset) | TEE pre-sign value limit + contract allowlist; a violation webhook kills the agent (see below) |
| Demo cap | `AGENT_MAX_ITERATIONS` | `0` (∞) | stop after N ticks |
| Dry run | `AGENT_DRY_RUN` | `true` | log intended actions without sending tx |

`AGENT_DRY_RUN` defaults **on** — flip it to `false` only after the wallet is
funded and you accept the bounded spend. Fund the wallet with **only** as much
testnet USDC as `inventory_cap_sets * usdcUnit` requires, so a bug can never
exceed it. (The signed voucher's per-market notional cap is calibre's contract-side
belt-and-suspenders on top of this.)

## Signer: Dynamic MPC server wallet (with a local-key fallback)

The agent signs from a **Dynamic MPC server wallet** — the Dynamic agentic-bounty
path (#618). When `DYNAMIC_API_KEY` + `DYNAMIC_ENVIRONMENT_ID` are set, it drives
Dynamic's documented Python SDK, [`dynamic-wallet-sdk`](https://www.dynamic.xyz/docs/python/quickstart)
(`calibre_agent.signer.DynamicServerWallet`):

```
DynamicEvmWalletClient(env_id)
  .authenticate_api_token(token)
  .create_wallet_account(threshold_signature_scheme=…, password=…) → WalletProperties
  .send_transaction(address=…, tx=…, password=…, rpc_url=…) → tx_hash
```

It's **TSS-MPC**: the single private key never exists — your server and Dynamic
each hold a key share. At startup the agent provisions a fresh MPC wallet (or
adopts an existing one via `DYNAMIC_WALLET_ID` + `DYNAMIC_ACCOUNT_ADDRESS`) and
persists only the **non-sensitive** `wallet_id` + `account_address`. The SDK's
`send_transaction` **signs and broadcasts** in one MPC round-trip (legacy
`gasPrice` transactions only — no EIP-1559 fields), so the contract client calls
it directly rather than broadcasting raw bytes itself.

Install the SDK with the optional extra (it's lazily imported, so the testnet
artifact installs without it): `pip install 'calibre-agent[server-wallet]'`.

**Sensitive material handling (#618 invariant).** The API token and the wallet
`DYNAMIC_WALLET_PASSWORD` (which unlocks the Dynamic-held key shares) are wrapped
in a `SecretRef` — resolved lazily, redacted from every `repr`/log, and never
placed on the config dataclass or a plaintext DB column. In production point the
`SecretRef` resolver at a KMS / Secret Manager (AWS KMS, GCP Secret Manager,
Azure Key Vault — per Dynamic's storage best-practices) instead of a bare env var.

> **Backup decision.** We rely on Dynamic's **password-encrypted backup** of the
> MPC shares (the `password` passed to `create_wallet_account`) rather than
> self-custodying raw shares. The consequence: **lose `DYNAMIC_WALLET_PASSWORD`
> and you lose the wallet** — store it durably in your vault. (Self-custody of raw
> shares is a Node-SDK-only path the Python SDK does not expose.)

For running against Arc testnet without a Dynamic account, set `AGENT_PRIVATE_KEY`
instead and the agent signs with a local `eth-account` key (`LocalKeySigner`,
returning raw bytes the client broadcasts) — the same primitive the repo's `sdk`
uses. Swapping signers never touches the strategy or loop.

> A real Dynamic environment and a funded Arc testnet server wallet are
> owner/booth-gated. This repo ships only `.env.example` placeholders; supply
> real values (and the KMS binding) in your own environment. The live-testnet-buy
> success check is owner/booth work; the SDK contract is covered by faithful-fake
> unit tests in `tests/test_signer.py`.

## MPC policies + violation webhook (#619)

On top of the server wallet (#618), Dynamic can enforce **MPC policies** in the
TEE **before** signing: a transaction that exceeds a per-token value limit or
touches a non-allowlisted address is rejected *pre-sign*, and Dynamic emits a
`waas.policy.violation` webhook. This bounds a buggy/compromised agent at the
**signing layer**, not just in app code — defense-in-depth on top of the
inventory cap + kill-switch above.

### Owner step — create the policy rules in the Dynamic dashboard

The rules themselves are created in the **Dynamic dashboard** (it needs dashboard
credentials, so it cannot be scripted from this repo). Create these on the
agent's server wallet ([policies docs](https://www.dynamic.xyz/docs/overview/wallets/embedded-wallets/mpc/policies)):

1. **Allowlist (whitelist mode).** Only allow rules pass; everything else is
   blocked. Allowlist exactly two addresses on Arc:
   - the deployed **`CalibreMarket`** contract (`CALIBRE_MARKET_ADDRESS`), and
   - the **Arc USDC** token (`ARC_USDC_ADDRESS`) — the agent `approve`s it.

   > Policies evaluate **every** address in a transaction's execution path: if a
   > listed address is a **proxy**, allowlist its implementation contract too, or
   > the call is rejected.
2. **Value limit (per token = USDC).** Add a value limit so a single transaction
   can move at most `inventory_cap_sets * usdcUnit` USDC base units — the same
   bound the loop's inventory cap enforces, now also enforced pre-sign. (For a
   native-token limit you'd leave the token address blank; here the limit is on
   the USDC ERC-20.)

### Webhook handler (built here)

`calibre_agent.policy_webhook.handle_webhook(raw_body, signature_header, *,
secret, kill_switch_file, on_violation=None)` is the handler a thin web shim
(Flask / FastAPI / serverless function) calls with the raw request body + the
`x-dynamic-signature` header. The agent itself ships **no web framework
dependency**; the handler is framework-agnostic stdlib.

- **Signature verification** is faithful to Dynamic's
  [documented scheme](https://www.dynamic.xyz/docs/recipes/webhooks-signature-validation):
  `HMAC-SHA256` over the **raw request body** under `DYNAMIC_WEBHOOK_SECRET`,
  hex-encoded and prefixed `sha256=`, compared in constant time. An
  unsigned/badly-signed/tampered/non-JSON delivery is **rejected** (caller returns
  HTTP 401) and does nothing. We HMAC the raw bytes as received, never a
  re-serialized dict — the docs warn the payload structure must match byte-for-byte.
- On a **verified `waas.policy.violation`** the handler logs the violation
  (`reasonCode`, `deniedAddresses`, `asset`, `walletId`, `messageId`) and **kills
  the agent** by writing `AGENT_KILL_SWITCH_FILE`, so `loop.run` halts new actions
  on the next tick — reusing the existing kill mechanism, not a parallel one. Any
  verified non-violation event (e.g. `wallet.created`) is a **no-op**.

Set `DYNAMIC_WEBHOOK_SECRET` (the per-webhook secret from the dashboard) and
`AGENT_KILL_SWITCH_FILE` to wire it up. Covered by faithful-fake unit tests in
`tests/test_policy_webhook.py` (the test signs payloads the way the real Dynamic
sender does). The live success check — a real over-limit / non-allowlisted tx
being rejected pre-sign and firing the webhook — needs the dashboard rules
applied, a funded server wallet, and a public webhook URL: owner/booth work.

## Voucher source: calibre signer (with a local-key fallback)

The W1.2 buy leg needs a voucher signed by calibre's `voucherSigner`. Set
`CALIBRE_VOUCHER_API_BASE` to fetch LMSR-priced, backend-signed vouchers from
calibre's quote endpoint (W3.1, the production path). For an offline/testnet run
with no calibre backend, set `AGENT_VOUCHER_SIGNER_KEY` instead and the agent
signs the voucher locally against `CalibreMarket`'s frozen EIP-712 domain +
`Quote` struct. Both yield the identical artifact (a signed voucher), so swapping
sources never touches the contract client or the loop.

> The calibre voucher endpoint is owner/booth-gated; `CalibreVoucherClient`'s
> request/response shape is documented from the W1.2 interface. The local signer
> is **testnet only** — its key is the contract's `voucherSigner`, distinct from
> the agent's tx-signing key.

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
# pick a tx signer:
export DYNAMIC_API_KEY=...  DYNAMIC_ENVIRONMENT_ID=...   # MPC server wallet (bounty)
export DYNAMIC_WALLET_PASSWORD=...                       # unlocks the MPC key shares
# or, for a testnet dry run without Dynamic:
export AGENT_PRIVATE_KEY=0x...
# pick a voucher source (W1.2 buy leg):
export CALIBRE_VOUCHER_API_BASE=https://.../api/v1       # calibre signer (production)
# or, for a testnet run without a calibre backend:
export AGENT_VOUCHER_SIGNER_KEY=0x...                    # local voucherSigner key

python -m calibre_agent            # or: calibre-agent
```

By default it polls every 15s in dry-run; set `AGENT_DRY_RUN=false` to trade.

## Test

```bash
cd agent && pip install -e ".[test]" && python -m pytest tests/
```

33 offline tests (no network, no chain) cover the band gate, inventory cap,
redeem-on-resolve, dry-run, kill-switch, max-iterations, config-from-env, the
price-feed status handling, and the W1.2 voucher path — including the EIP-712
digest-parity guard against `CalibreMarket.hashQuote`.

## Chain params (Arc testnet)

| Field | Value |
|---|---|
| chainId | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |
| USDC | ERC-20 interface is **6-decimal** (native gas token is 18-decimal — the contract reads `usdcUnit` from `usdc.decimals()`, so the agent never hardcodes the scale) |
