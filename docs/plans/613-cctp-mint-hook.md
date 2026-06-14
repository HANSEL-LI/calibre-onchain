# 613 — CCTP V2 Hooks: bridge-and-mint-on-arrival (`DepositAndMintHook.sol`)

Issue: HANSEL-LI/Calibre#613. Target repo: `calibre-onchain` (this repo).
Umbrella: HANSEL-LI/Calibre#609. Branch: `feat/613-cctp-mint-hook`.

## Goal

A destination-side CCTP V2 **Hook contract** so a user bridging USDC from any
chain (Base/Arbitrum testnet → Arc, CCTP domain **26**) mints a complete set on
`CalibreMarket` in the same destination-side relay transaction — removing the
"get USDC onto Arc first" onboarding wall.

The bridged USDC lands on `CalibreMarket` and the resulting `sets` YES + `sets`
NO shares are credited to the end recipient, all driven by the hook payload the
user attached to their source-chain burn.

**Out of scope (explicit in the issue):** the Circle Gateway unified-balance
variant; the live cross-chain testnet bridge run (owner booth/demo step). This
PR ships the contract + Foundry test + deploy wiring — the headless deliverable.

## How CCTP V2 hooks actually work (researched — Circle source, verbatim)

CCTP V2 does **not** auto-invoke a hook. `depositForBurnWithHook` on the source
chain carries a `hookData` blob inside the **BurnMessageV2** body (dynamic field
at byte offset **228**, per `circlefin/evm-cctp-contracts`
`src/messages/v2/BurnMessageV2.sol`). On the destination, `MessageTransmitterV2`
only mints USDC to the burn's `mintRecipient`; it never calls the recipient with
the hook. Hook execution is **caller-controlled** — a relayer runs Circle's
reference **`CCTPHookWrapper`** (`src/examples/CCTPHookWrapper.sol`), whose
`relay(message, attestation)`:

1. validates the V2 message/body, then calls
   `messageTransmitter.receiveMessage(message, attestation)` — this mints USDC to
   the `mintRecipient`;
2. parses `hookData` as `target(20 bytes) ++ hookCallData(dynamic)` and does
   `address(target).call(hookCallData)` (non-atomic with the mint by design).

So the correct integration is: set the burn's **`mintRecipient` = our hook**, and
set **`hookData = abi.encodePacked(address(hook), hookCallData)`** where
`hookCallData` is an ABI-encoded call to a function on the hook. After the mint,
the wrapper calls our hook; the USDC is already sitting in the hook's balance.
The hook reads its own USDC balance, mints a complete set on `CalibreMarket`, and
forwards both share legs to the recipient.

Refs (Circle, repo `circlefin/evm-cctp-contracts`):
- `src/examples/CCTPHookWrapper.sol` — `relay()` + `_executeHook()` (`target.call`).
- `src/messages/v2/BurnMessageV2.sol` — `HOOK_DATA_INDEX = 228`, `_getHookData`.
- `src/interfaces/v2/IMessageHandlerV2.sol`, `IReceiverV2.sol`.
- Doc: https://www.circle.com/blog/cctp-v2-the-future-of-cross-chain ; technical
  guide https://developers.circle.com/cctp/technical-guide
- **Arc**: CCTP V2 domain **26**, standard Transfer + Forwarding. Fast Transfer is
  N/A on Arc (standard attestation is already fast), so there is **no
  Fast-Transfer-liquidity concern** — we build the standard-attestation path.

## Design — `DepositAndMintHook.sol`

```solidity
contract DepositAndMintHook {
    IERC20 public immutable usdc;            // same 6-dec ERC-20 CalibreMarket uses
    CalibreMarket public immutable market;   // constructor-injected mint target

    // The CCTP wrapper calls this after USDC is minted into this contract.
    // hookCallData on the source burn = abi.encodeCall(
    //     DepositAndMintHook.depositAndMint, (chainMarketId, recipient));
    function depositAndMint(uint256 chainMarketId, address recipient)
        external returns (uint256 sets);
}
```

`depositAndMint`:
1. reads `bal = usdc.balanceOf(address(this))` — the freshly-minted bridge USDC;
2. `sets = bal / market.usdcUnit()`; `dust = bal % usdcUnit`;
3. reverts `NothingToMint` if `sets == 0` (no full set fundable);
4. `usdc.approve(market, sets * usdcUnit)`; `market.mint(chainMarketId, sets)`
   (shares land on the hook — `mint` credits `msg.sender`);
5. `market.transferShares(id, true, recipient, sets)` and
   `transferShares(id, false, recipient, sets)` — forward both legs;
6. refunds `dust` USDC to `recipient` (see decision); emits
   `DepositMinted(chainMarketId, recipient, sets, dust)`.

`recipient == address(0)` reverts `ZeroAddress`. Unknown / unset market reverts
inside `market.mint` (`UnknownMarket`) — surfaced, not swallowed.

## Decisions

- **Hook target == mintRecipient (single contract), `depositAndMint(id, recipient)`
  selector-style hookCallData.** This matches Circle's `CCTPHookWrapper._executeHook`
  exactly (`target.call(hookCallData)`), so no custom wrapper/relayer protocol is
  invented — any standard CCTP V2 hook relayer drives it. The hook is the burn's
  `mintRecipient` so the USDC is in-hand when it runs.
- **Balance-driven `sets`, not an amount argument.** The hook derives `sets` from
  its *actual* USDC balance rather than trusting an encoded amount, so a fee taken
  by a fast-path executor or a partial mint can't desync the math; whatever
  arrived is what's minted.
- **Dust (`bal % usdcUnit`) is refunded to `recipient`, not reverted.** A bridge
  amount that isn't an exact multiple of `usdcUnit` (1 USDC) is realistic (fees,
  arbitrary user amounts). Reverting would strand the entire (already-minted,
  already-relayed, non-atomic) USDC in the hook — the worst outcome since the CCTP
  mint cannot be undone. Refunding the sub-unit remainder to the recipient while
  minting the affordable whole sets is the safe, value-preserving choice. If
  `sets == 0` (less than one whole unit bridged) we revert `NothingToMint`; in
  that non-atomic-failure case the dust sits in the hook recoverable by a
  `sweep` (owner-less, recipient-directed) — see below.
- **Permissionless, stateless, custody-light — with one caveat (see Security).**
  In the happy path the hook holds no funds between calls (it forwards shares +
  refunds dust in the same tx), so it is ownerless and needs no access control: it
  mints a complete set (fully USDC-backed by construction in `CalibreMarket`) and
  hands both legs to the caller-named recipient. A `sweep(recipient)` lets anyone
  flush a stuck balance (e.g. after a `NothingToMint` revert) to a recipient by
  minting/refunding; kept minimal.
- **Security — a stranded balance is first-mover-claimable, not "harmless dust".**
  `_depositAndMint` mints from the hook's *entire* current USDC balance to a
  **caller-supplied** `recipient`, with no per-depositor accounting. CCTP does NOT
  enforce that the `hookData` target equals the burn's `mintRecipient` (verified
  against Circle's `CCTPHookWrapper`), so if a user sets `mintRecipient = hook` but
  mis-encodes the hook target — or the relayer never fires the hook — their **full**
  bridged amount sits on the hook, and *any* caller can then `sweep(id, attacker)`
  to mint a redeemable/tradeable complete set funded by that USDC. The stranded
  amount is **not** bounded to dust and the griefer names *themselves*, so this is
  theft of value, not a harmless reassignment. It does not affect the happy path
  (one atomic relay tx where the hook nets to zero), but the escape hatch is
  first-mover-wins. Hardening — bind stranded funds to their rightful recipient
  (derive `recipient` from the CCTP message, or accrue per-`mintRecipient` credit)
  — is tracked as a follow-up (Calibre#647), not folded into this PR, since it is a
  larger redesign than the happy-path mint this PR scopes.
- **No `usdcUnit` of its own** — read through `market.usdcUnit()` so the hook and
  market can never disagree on the unit (single source of truth).
- **`approve` exact, every call.** We approve `sets * usdcUnit` immediately before
  `mint` and the market pulls exactly that, so no lingering allowance.

## Files to touch

- `contracts/src/DepositAndMintHook.sol` — new: the hook contract.
- `contracts/test/DepositAndMintHook.t.sol` — new: end-to-end coverage via a mock
  CCTP relay path + dust + revert cases.
- `contracts/test/mocks/MockHookRelay.sol` — new: a tiny stand-in for Circle's
  `CCTPHookWrapper` — mints USDC to the hook (simulating `receiveMessage`) then
  `target.call(hookCallData)` (simulating `_executeHook`), so the test drives the
  *real* hook the way a relayer would.
- `contracts/script/DeployHook.s.sol` — new: deploy the hook against an existing
  `CalibreMarket` (+ Arc domain 26 constant documented).
- (reuse existing `contracts/test/mocks/MockUSDC.sol`, `src/IERC20.sol`,
  `src/CalibreMarket.sol` — no edits.)

## Named commit phases

1. `docs(plans): 613 CCTP V2 mint-hook plan` — this file (first commit).
2. `feat(contracts): DepositAndMintHook — bridge-and-mint complete set on arrival`.
3. `test(contracts): mock CCTP relay → mint+transfer end-to-end, dust, reverts`.
4. `feat(contracts): DeployHook.s.sol + Arc domain-26 deploy wiring`.

## Tests (`cd contracts && forge build && forge test`)

- `test_RelayMintsCompleteSetToRecipient` — relay flow: mint USDC to hook + call
  `depositAndMint` → recipient holds `sets` YES and `sets` NO; CalibreMarket holds
  `sets * usdcUnit` locked USDC; hook holds nothing.
- `test_DustRefundedToRecipient` — bridge `N*usdcUnit + dust` → mints `N` sets,
  refunds exactly `dust` to recipient, hook ends at zero.
- `test_RevertWhen_NothingToMint` — bridge `< usdcUnit` → `depositAndMint` reverts
  `NothingToMint`; `sweep` recovers the stuck dust to a recipient.
- `test_RevertWhen_ZeroRecipient` — `recipient == address(0)` reverts.
- `test_RevertWhen_UnknownMarket` — unset market id bubbles `UnknownMarket` from
  `CalibreMarket.mint`.
- `test_DirectCallEquivalentToRelay` — calling `depositAndMint` directly (USDC
  pre-funded) gives the same result, proving the hook is relay-agnostic.

Run: `cd contracts && forge build && forge test -vvv`.

## Risks

- **Non-atomic mint vs hook** is a CCTP V2 property, not ours: if the relayer's
  hook call fails, USDC is already minted to the hook. We mitigate by (a) never
  reverting on dust, and (b) a `sweep` escape hatch so a stuck balance is always
  recoverable to a recipient. Documented in the contract.
- **Live testnet bridge run** (Base/Arbitrum → Arc) needs the deployed Arc
  `CalibreMarket` address + a relayer + testnet USDC — that is the owner's demo
  step (BLOCKED), not part of this headless PR.
- Decimals: the hook never hard-codes `1e6`; it reads `market.usdcUnit()`.
