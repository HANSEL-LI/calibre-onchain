# DEPLOY-RUNBOOK — live Arc deploy + hero-flow proof (A6, #456)

The reproducible runbook for the **owner/booth-gated** live deploy. Everything in
the repo is code-complete and merged; this is the dress rehearsal that flips the
live-money flags on and proves the full hero flow against a real deployment with
observed USDC balance changes.

> **Owner-gated.** Every step below needs the owner's accounts, credentials, and
> funded testnet wallets. Nothing here runs in CI. Treat every key as **testnet
> only** — the `.env.example` ships placeholders, never commit real keys.

**Order matters.** Do the steps top-to-bottom. The contract set-order (step 3) and
the digest re-confirmation (step 7) are the two places a silent break hides: a
wrong set-order leaves `buy` reverting on an unset signer/counterparty, and a
wrong address/chainId in the signer env breaks every voucher with `BadSignature`.

---

## 0. Network facts (Arc testnet)

| | |
|---|---|
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| USDC faucet | `https://faucet.circle.com` |
| USDC interface | **6-decimal ERC-20** — never the 18-decimal native gas asset (W8 §3) |

Copy `.env.example` → `.env` at the repo root and fill values as each step
produces them. The variable each step sets is named in **bold** in step 9's table.

---

## 1. Fund the testnet wallets

Three roles need Arc testnet USDC + gas (some roles can share one key for the
demo, but keep the resolver key throwaway):

| Role | Needs | Why |
|---|---|---|
| **Deployer / resolver** | gas | deploys `CalibreMarket`, runs all `onlyResolver` admin calls |
| **Counterparty** | USDC + gas | fronts the backing USDC for seeded inventory; receives buyers' reimbursements |
| **Agent / buyer** | USDC + gas | the `msg.sender` of `buy`; reimburses the counterparty for the side it takes |

Fund from the Circle faucet (`https://faucet.circle.com`). Record each address.

> **Gas is paid in USDC on Arc** — there is no separate native gas token to
> chase. A single USDC drip to an address covers both its backing role *and* its
> transaction gas; the deployer/resolver, which only sends admin txs, just needs
> a small USDC balance for gas. (`cast balance` shows an 18-dec native mirror of
> the same USDC; amounts in the contract are always the 6-dec ERC-20 — §0.)

---

## 2. Deploy `CalibreMarket` to Arc

```bash
cd contracts
export USDC_ADDRESS=0x...          # 6-dec ERC-20 USDC on Arc testnet (ARC_USDC_ADDRESS)
export RESOLVER_ADDRESS=0x...      # initial resolver (throwaway weekend key)
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.testnet.arc.network --broadcast
```

Record the logged `CalibreMarket deployed: 0x...` →set **`CALIBRE_MARKET_ADDRESS`**
in `.env`, and **`ARC_USDC_ADDRESS`** = the USDC token. Save the deploy tx hash for
the README deployment table.

`Deploy.s.sol` only constructs the contract (`usdc`, `resolver`). The maker wiring
is the next step.

---

## 3. Configure the contract — exact set order

All admin calls are `onlyResolver`; send them from `RESOLVER_ADDRESS`. **This is
the order `EndToEnd.s.sol` proves and the order to follow live:**

1. **`setVoucherSigner(signerAddr)`** — the address of calibre's W3.1 voucher
   signing key (`VOUCHER_SIGNER_KEY`'s address). Until set, `buy` reverts.
2. **`setCounterparty(counterpartyAddr)`** — the inventory-holding address from
   step 1. Until set, `seedInventory` reverts (`CounterpartyUnset`).
3. **`createMarket(chainMarketId)`** — register each binary market (the
   `chainMarketId` is minted off-chain by calibre). Idempotent guard:
   `MarketExists` on a repeat.
4. **Counterparty `approve(CALIBRE_MARKET_ADDRESS, amount)` on the USDC token** —
   `seedInventory` *pulls* USDC from the counterparty, so it must approve the
   market first (`amount ≥ sets * usdcUnit`).
5. **`seedInventory(chainMarketId, sets)`** — pulls `sets * usdcUnit` USDC from the
   counterparty and credits it `sets` YES + `sets` NO shares (the standing
   inventory buyers later draw from). One USDC unit locked per complete set ⇒
   solvent by construction.
6. *(optional)* **`setMarketNotionalCap(chainMarketId, cap)`** — per-market USDC
   notional ceiling on `buy` (`0` disables).

> The **buyer** must likewise `approve(CALIBRE_MARKET_ADDRESS, maxCost)` on USDC
> before its first `buy` — `buy` pulls exactly `quote.maxCost` from buyer to
> counterparty (#465).

Optionally hand the resolver role to the backend signer with
`setResolver(backendSigner)` once seeding is done (W1.3 migration). `cast send`
each call, or drive them from the private app's resolver path.

---

## 4. Deploy the ENS offchain resolver + run the gateway

The gateway serves CCIP-read answers for `<name>.calibre.eth` from calibre's
public profile API; the on-chain resolver follows `OffchainLookup` to it.

1. Deploy an offchain resolver that mirrors `ensdomains/offchain-resolver`
   (reference: [`gateway/contract/OffchainResolverStub.sol`](../gateway/contract/OffchainResolverStub.sol)).
   Allowlist the **address of `GATEWAY_SIGNER_KEY`** as a valid signer, and set its
   `url` to the public gateway URL. Record its address →**`GATEWAY_RESOLVER_ADDRESS`**.
2. Point a name at it: set the offchain resolver as the resolver for
   `calibre.eth` (or the testnet equivalent the ENS booth designates) →
   **`ENS_PARENT`**. Pick an RPC that can resolve it (e.g. Sepolia via Tenderly) →
   **`ENS_RPC_URL`**.
3. Run the gateway:
   ```bash
   cd gateway && npm install && npm run build
   GATEWAY_PORT=8080 \
   CALIBRE_PUBLIC_API_BASE=https://app.hicalibre.gg/api/v1 \
   GATEWAY_SIGNER_KEY=0x... \
   GATEWAY_RESOLVER_ADDRESS=0x... \
   npm start
   ```
   Smoke-test: `GET /health` → `{ ok, resolver, apiBase }`. Then resolve a known
   opted-in `display_name`: `<name>.calibre.eth` should return that user's
   `addr()` + `gg.calibre.rank` / `com.discord` text records.

"Updating a text record" = updating calibre's DB (free + instant); the gateway
reads only the public profile API and never touches the DB.

---

## 5. Create a Dynamic environment (embedded-wallet onboarding)

In the Dynamic dashboard, create a **testnet** environment. Record:

- **`DYNAMIC_ENVIRONMENT_ID`** — the environment id (public; reaches the SPA via
  `/config`).
- **`DYNAMIC_API_KEY`** — server API key (secret; stays server-side).
- **`DYNAMIC_JWT_AUDIENCE`** — the JWT `aud` the calibre `/accounts/wallet` verifier
  expects (must match what Dynamic issues; the #467 guard rejects `alg=none` /
  RS256-confusion tokens, so the audience + alg must line up).

These set the calibre-side `DYNAMIC_ENABLED` leg (step 8). Optionally
`DYNAMIC_WALLET_ID` for an existing server wallet.

---

## 6. Blink + Discord credentials

- **Blink** (one-tap USDC deposit): from the Blink booth, get the destination
  param + **`BLINK_API_KEY`** / **`BLINK_WEBHOOK_SECRET`** and set
  `BLINK_DESTINATION_MODE`. Sets the calibre-side `BLINK_ENABLED` leg.
- **Discord** (role-sync bot, reads ENS only — never calls calibre):
  - **`DISCORD_BOT_TOKEN`**, **`DISCORD_APP_ID`**, **`DISCORD_GUILD_ID`**.
  - The bot **auto-creates** the per-tier managed roles in the guild on start, so
    the demo guild needs no manual role setup. Invite the bot with
    `Manage Roles` + the managed role below the bot's own role.
  - Reuses **`ENS_RPC_URL`** / **`ENS_PARENT`** from step 4; `RESYNC_INTERVAL_MS`
    defaults to 5 min.
  ```bash
  cd discord-bot && npm install && npm run build && npm start
  ```

---

## 7. Re-confirm the EIP-712 digest against the DEPLOYED contract

**Gate before flipping live flags.** The offline parity test proves the source is
byte-equal to `hashQuote`; this proves the *configured deployment* (address +
chainId) is too — catching a typo'd `CALIBRE_MARKET_ADDRESS` or chainId that would
make every `buy` revert with `BadSignature`.

```bash
cd agent && pip install -e .
CALIBRE_MARKET_ADDRESS=0x...   \
ARC_RPC_URL=https://rpc.testnet.arc.network \
ARC_CHAIN_ID=5042002           \
python scripts/verify_deployed_digest.py
```

The script computes the agent signer's off-chain digest (from the agent's frozen
`_QUOTE_TYPES`) and reads `hashQuote` off the live contract, then compares:

- **`DIGEST MATCH`** (exit 0) → signer is byte-equal with the deployment. Proceed.
- **`DIGEST MISMATCH`** (exit 1) → **stop.** Fix `CALIBRE_MARKET_ADDRESS` /
  `ARC_CHAIN_ID` and re-run before enabling anything. File a P0 fix issue if the
  mismatch is in the code, not the config.

---

## 8. Flip the calibre-side live flags

In the **private** calibre app's `Settings` (`deploy/env.example` contract), all
gates default **OFF**. Enable each leg only after its prerequisites above are
green:

| Flag | + required values | Gates |
|---|---|---|
| `ONCHAIN_RESOLVE_ENABLED` | `ONCHAIN_CONTRACT_ADDRESS` / `ONCHAIN_RPC_URL` / `ONCHAIN_RESOLVER_KEY` / `ONCHAIN_CHAIN_ID=5042002` | Seam 1 settle mirror |
| `VOUCHER_SIGNER_ENABLED` | `VOUCHER_SIGNER_KEY` / `VOUCHER_TTL_S` / `VOUCHER_MAX_NOTIONAL_USDC` | A-lite voucher signer |
| `DYNAMIC_ENABLED` | `DYNAMIC_ENVIRONMENT_ID` / `DYNAMIC_API_KEY` / `DYNAMIC_JWT_AUDIENCE` | Dynamic onboarding |
| `BLINK_ENABLED` | `BLINK_DESTINATION_MODE` / `BLINK_API_KEY` / `BLINK_WEBHOOK_SECRET` | Blink deposit |

`ONCHAIN_CONTRACT_ADDRESS` / `ONCHAIN_CHAIN_ID` here **must** equal the values that
passed step 7.

---

## 9. Env-var checklist (what each step produces)

| Var | Set in step | Notes |
|---|---|---|
| `ARC_USDC_ADDRESS` | 2 | 6-dec ERC-20 USDC token |
| `CALIBRE_MARKET_ADDRESS` | 2 | deployed market; feeds step 7 + `ONCHAIN_CONTRACT_ADDRESS` |
| `RESOLVER_PRIVATE_KEY` | 1–3 | throwaway resolver/deployer key |
| `GATEWAY_RESOLVER_ADDRESS` | 4 | deployed offchain resolver |
| `GATEWAY_SIGNER_KEY` | 4 | CCIP-read response signer; address allowlisted on the resolver |
| `CALIBRE_PUBLIC_API_BASE` | 4 | e.g. `https://app.hicalibre.gg/api/v1` |
| `ENS_PARENT` | 4 | e.g. `calibre.eth` (booth-designated) |
| `ENS_RPC_URL` | 4 | RPC that resolves `*.calibre.eth` |
| `DYNAMIC_ENVIRONMENT_ID` | 5 | public; reaches SPA via `/config` |
| `DYNAMIC_API_KEY` | 5 | secret; server-side only |
| `DYNAMIC_JWT_AUDIENCE` | 5 | must match Dynamic's issued `aud` |
| `BLINK_API_KEY` / `BLINK_WEBHOOK_SECRET` | 6 | secret |
| `DISCORD_BOT_TOKEN` / `DISCORD_APP_ID` / `DISCORD_GUILD_ID` | 6 | bot creds |

---

## 10. Hero-flow proof — record this end-to-end

With every leg live, drive the full flow in a browser and **observe USDC balance
deltas at each money step** (read balances on `https://testnet.arcscan.app` or via
`cast call <USDC> "balanceOf(address)"`). Record the run (feeds the S2 demo video,
#464).

- [ ] **Connect** — sign in, Dynamic embedded wallet provisioned for the user.
- [ ] **Deposit (Blink)** — one-tap fund; **buyer USDC ↑** by the deposit.
- [ ] **Quote** — the private app prices the buy off the live LMSR and returns a
      signed EIP-712 voucher (`maxCost == cost`, #465).
- [ ] **Buy** — `buy(quote, sig)` with `msg.sender == quote.buyer`; tx confirms.
      **Buyer USDC ↓ by `maxCost`, counterparty USDC ↑ by the same**; buyer credited
      the side's shares. (A wrong digest here ⇒ `BadSignature` — step 7 should have
      caught it.)
- [ ] **Resolve** — `resolve(chainMarketId, YES|NO)` from the resolver once the
      match settles; `Resolved` event emitted.
- [ ] **ENS record** — the winner's `gg.calibre.rank` (tier) text record reflects
      the updated standing: resolve `<name>.calibre.eth` and read it back.
- [ ] **Discord role** — within `RESYNC_INTERVAL_MS` (or via `/link`), the member's
      rank role flips in the guild to match the ENS tier.
- [ ] **Redeem** — `redeem(chainMarketId)` pays winning shares 1:1; **winner USDC ↑
      by `shares * usdcUnit`**, losing-side shares untouched.
- [ ] **Solvency** — after all redemptions, the contract drains to zero residual
      (locked USDC exactly backed the minted pairs). `EndToEnd.s.sol` asserts this
      shape for a fresh deploy; confirm it holds live.

> **Driving a live round-trip:** `forge script` against Arc reverts on any
> `transferFrom`-bearing step — its local fork can't execute Arc's
> `isBlocklisted` precompile (`0x1800…0001`), so seed/buy/redeem fail in
> simulation (`StackUnderflow`) even though they succeed on real broadcast. Use
> **`cast send`** for the live settlement steps (see
> [`contracts/live-proof.sh`](../contracts/live-proof.sh), the deployer-wears-all-roles
> round-trip). `EndToEnd.s.sol` in **LOCAL** mode (MockUSDC, no Arc precompile)
> remains the deterministic set-order + solvency proof.

---

## 11. On failure

Any leg that fails is a **P0 fix issue** filed against the owning repo (this issue
files, it doesn't fix). Capture the tx hash / revert reason / observed-vs-expected
balance in the issue so the fix has a faithful repro. Re-run from the failed step
after the fix lands; step 7 and the hero-flow checklist are both idempotent.

---

## Reference

- Set-order + solvency proof: [`contracts/script/EndToEnd.s.sol`](../contracts/script/EndToEnd.s.sol)
- One-shot testnet deploy: [`contracts/deploy-testnet.sh`](../contracts/deploy-testnet.sh) (preflight + `Deploy.s.sol` + writes `CALIBRE_MARKET_ADDRESS`)
- Live settlement round-trip (cast send): [`contracts/live-proof.sh`](../contracts/live-proof.sh)
- EIP-712 surface: [`contracts/src/CalibreMarket.sol`](../contracts/src/CalibreMarket.sol) `hashQuote`, [`agent/src/calibre_agent/voucher.py`](../agent/src/calibre_agent/voucher.py)
- Digest re-confirm: [`agent/scripts/verify_deployed_digest.py`](../agent/scripts/verify_deployed_digest.py)
- ENS gateway: [`gateway/README.md`](../gateway/README.md)
- Config/flag map: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) §6
- Demo storyboard: [`docs/DEMO-SCRIPT.md`](DEMO-SCRIPT.md)
