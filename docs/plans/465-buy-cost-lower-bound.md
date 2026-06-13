# Fix #465 — `buy()` has no lower bound on `cost` (counterparty inventory drainable)

## Gap (A1 audit #451)

`CalibreMarket.buy(Quote q, uint256 cost, bytes sig)` enforces only an **upper**
bound on the USDC charged (`if (cost > q.maxCost) revert MaxCostExceeded`). The
EIP-712 signature covers `q.maxCost` but **not** the actual `cost`, which is an
unsigned caller-supplied argument. A voucher holder can call `buy(q, 0, sig)` and
receive `q.size` shares from `counterparty` inventory while paying ~0 USDC, then
redeem 1:1 after resolve — a direct counterparty fund-drain. It also nullifies
`marketNotionalCap` as an exposure bound (the cap meters `cost`).

## Decision — Option 1: charge the signed price, drop the unsigned `cost` arg

The A1 audit recommends option 1 (charge the signed amount, remove the unsigned
`cost`). I take it over option 2 (add a signed `minCost`/exact `cost` to the
`Quote` struct + typehash) for these reasons:

- **No typehash change.** A3 forge-verified the `Quote` digest is byte-equal
  across the Python signer and Solidity. Option 1 leaves `_QUOTE_TYPEHASH`,
  `hashQuote`, the domain separator, and every signed field untouched — only the
  `buy()` ABI changes (drop one unsigned arg). Option 2 would force a coordinated
  bump of the frozen W1.2↔W3.1 typehash + the backend signer + `hashQuote`,
  exactly the disturbance the issue warns against.
- **`maxCost` already is the signed price.** It is the only signed USDC field. The
  1% buffer (`maxCost = quote × 1.01`) existed *only* because `cost` could come in
  lower; once the buyer always pays the signed amount, the signer simply signs
  `maxCost = the exact price it wants charged`. The buyer pays exactly the price
  the signer committed to — the audit's stated goal.
- **Repo already assumes this shape.** `EndToEnd.s.sol` signs `maxCost: cost`
  (cost == maxCost) and the README documents `buy(quote, sig)` (2-arg). Option 1
  makes the contract match what the proof script and docs already say.

Net: `buy(Quote q, bytes sig)` charges `q.maxCost` directly. The buyer can no
longer under-pay; the notional cap meters the real charge.

## Files to touch

- `contracts/src/CalibreMarket.sol` — drop the `cost` param from `buy()`; charge
  `q.maxCost`; remove the now-dead `MaxCostExceeded` error and its check; update
  the `buy` NatSpec and the `maxCost` field comment. The `Quote` struct,
  typehash, `hashQuote`, and domain separator are **untouched**.
- `contracts/test/CalibreVoucher.t.sol` — drop the `cost` arg from every
  `market.buy(...)` call; add the **regression test** (`test_RevertWhen_*` /
  `test_BuyChargesSignedMaxCost`) proving a below-`maxCost` charge is impossible:
  the buyer is charged exactly `maxCost`, counterparty USDC is not under-collected.
  Remove `test_RevertWhen_CostAboveMaxCost` (the arg it tests no longer exists)
  and replace with a "charges the signed amount" assertion.
- `contracts/script/EndToEnd.s.sol` — drop the `cost` arg from the `buy` call
  (already signs `maxCost == cost`, so the broadcast charge is unchanged).
- `agent/src/calibre_agent/contract.py` — drop the `cost` ABI input + the
  `voucher.cost` arg from the `buy(...)` web3 call; the agent now relies on the
  voucher's signed `maxCost` as the charge.
- `agent/src/calibre_agent/voucher.py` — keep `cost` on `SignedVoucher` for the
  agent's own bookkeeping/logging, but it is no longer sent to the contract; note
  this in the docstring (signer must set `maxCost` to the intended charge).
- `agent/tests/test_voucher.py` — adjust the `buy`-call assertion to the new ABI
  (no `cost` arg in the emitted call) if it inspects the emitted tuple.
- `README.md` / NatSpec — already describe `buy(quote, sig)`; verify and align.

## Named commit phases

1. `docs(plans): #465 plan — drop unsigned cost from buy()` (this file).
2. `fix(contracts): buy() charges signed maxCost, drop unsigned cost arg (#465)`
   — `CalibreMarket.sol` + `EndToEnd.s.sol`.
3. `test(contracts): regression — below-maxCost buy is impossible (#465)`
   — `CalibreVoucher.t.sol`.
4. `fix(agent): align buy ABI to 2-arg buy(quote, sig) (#465)`
   — `agent/` contract.py / voucher.py / tests.

## Risks

- **Buyer pays 1% more than the old `cost`.** Acceptable + intended: the signer
  controls `maxCost`; to charge a fair `cost` it signs `maxCost = cost`. The 1%
  buffer was a slippage allowance that only made sense alongside a separate
  lower-bound-less `cost`. Filed as a calibre-side follow-up so the backend signer
  sets `maxCost` to the exact intended charge (not quote × 1.01) post-merge.
- **Calibre-side caller drift.** The private-app caller that submits the buy
  (`src/calibre/markets/onchain_voucher.py` + whatever broadcasts it) and the
  W3.1 signer must drop the `cost` arg. That repo is **out of scope for this PR**;
  filed as a follow-up issue in the calibre repo.

## Test command

```bash
cd /tmp/wt-465/contracts && forge test -vvv
```

All existing tests plus the new regression must pass. Agent tests:
```bash
cd /tmp/wt-465/agent && <venv> -m pytest tests/test_voucher.py
```
