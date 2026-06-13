// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CalibreMarket} from "../src/CalibreMarket.sol";
import {IERC20} from "../src/IERC20.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @dev `approve` is not on the vendored `IERC20` (CalibreMarket never calls it —
///      it only pulls via pre-granted allowances). The script must grant those
///      allowances itself, so it needs `approve` on both the local mock and the
///      live token. Kept local to the script to leave the production interface
///      untouched (W1.3 makes no contract-source changes).
interface IERC20Approve {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @title EndToEnd — scripted A-lite settlement proof (W1.3, HANSEL-LI/Calibre#423)
/// @notice The umbrella's Saturday-noon CUSTODY CHECKPOINT. This is a broadcastable
///         `forge script` (NOT a `Test` harness): it sends real transactions for
///         every step of the A-lite flow, so the round-trip itself — not an
///         in-memory assertion — is the pass/fail signal. A failed invariant
///         `require`s, the broadcast reverts, and the runner exits non-zero.
///         Green ⇒ custody stays Model A-lite. Red ⇒ degrades to Model B
///         (briefing §3: only W2.3/#427 and W3.1/#424 are casualties).
///
///         Flow proven end-to-end:
///           deploy(usdc, resolver)
///             → createMarket + setVoucherSigner + setCounterparty
///             → seedInventory (counterparty fronts USDC for complete sets)
///             → buy(quote, sig) — EIP-712 voucher signed off-chain, msg.sender == buyer
///                 (one YES buy + one NO buy)
///             → resolve(marketId, YES) by the resolver
///             → redeem winners 1:1 (buyer + counterparty residual)
///             → assert final USDC balances and drain-to-zero solvency.
///
/// @dev    CANONICAL RUN = local anvil (deterministic, no funding):
///           anvil
///           forge script script/EndToEnd.s.sol:EndToEnd \
///             --rpc-url http://127.0.0.1:8545 --broadcast -vvv
///
///         SAME SCRIPT vs LIVE ARC (owner/booth-gated — do not run unattended):
///           export USDC_ADDRESS=0x...   # real 6-dec ERC-20 USDC on Arc testnet
///           forge script script/EndToEnd.s.sol:EndToEnd \
///             --rpc-url https://rpc.testnet.arc.network \
///             --private-key $FUNDED_KEY --broadcast -vvv
///
///         Local vs live forks on whether `USDC_ADDRESS` is set (mirrors
///         Deploy.s.sol's `vm.envAddress`). Local deploys MockUSDC (6-dec,
///         matches the Arc ERC-20 interface) and mints to the actors so no
///         faucet is needed; live reads the real token and expects the funded
///         broadcaster to already hold USDC. USDC math uses the 6-decimal ERC-20
///         interface throughout (W8 spike §3) — never Arc's 18-dec native asset.
contract EndToEnd is Script {
    // Deterministic actor keys for the LOCAL run. On live Arc these are replaced
    // by the funded --private-key broadcaster; the voucher signer is whatever
    // key the backend resolver signer (W3.1) holds. Known keys here let the
    // script produce a real EIP-712 signature the on-chain `buy` verifies.
    uint256 internal constant RESOLVER_KEY = 0xA11CE; // also the voucher signer
    uint256 internal constant COUNTERPARTY_KEY = 0xB0B;
    uint256 internal constant BUYER_KEY = 0xCA11;

    uint256 internal constant MARKET_ID = 7;
    uint256 internal constant SEED_SETS = 100; // complete sets seeded into inventory
    uint256 internal constant YES_BUY = 30; // shares the buyer takes on YES
    uint256 internal constant NO_BUY = 10; // shares the buyer takes on NO

    function run() external {
        // --- Decide local-mock vs live-token (mirror Deploy.s.sol) -----------
        address usdcEnv = vm.envOr("USDC_ADDRESS", address(0));
        bool local = usdcEnv == address(0);

        address resolver = vm.addr(RESOLVER_KEY);
        address counterparty = vm.addr(COUNTERPARTY_KEY);
        address buyer = vm.addr(BUYER_KEY);
        address voucherSigner = resolver; // standing-counterparty quote signer

        console2.log("== W1.3 A-lite settlement e2e proof ==");
        console2.log(local ? "  mode: LOCAL (MockUSDC, deterministic)" : "  mode: LIVE (env USDC_ADDRESS)");
        console2.log("  resolver/signer:", resolver);
        console2.log("  counterparty:   ", counterparty);
        console2.log("  buyer:          ", buyer);

        // --- Deploy USDC (local) or bind the live token ----------------------
        IERC20 usdc;
        if (local) {
            vm.broadcast(RESOLVER_KEY);
            MockUSDC mock = new MockUSDC();
            usdc = IERC20(address(mock));
            console2.log("  MockUSDC deployed:", address(mock));
        } else {
            usdc = IERC20(usdcEnv);
            console2.log("  USDC (live):", usdcEnv);
        }

        // --- Deploy the settlement contract ----------------------------------
        vm.broadcast(RESOLVER_KEY);
        CalibreMarket market = new CalibreMarket(usdc, resolver);
        uint256 unit = market.usdcUnit();
        require(unit == 1e6, "expected 6-decimal USDC unit");
        console2.log("  CalibreMarket deployed:", address(market));
        console2.log("  usdcUnit (1 USDC base units):", unit);

        // --- Fund actors (LOCAL only; live actors arrive pre-funded) ---------
        if (local) {
            MockUSDC mock = MockUSDC(address(usdc));
            // Counterparty fronts backing for the seeded sets; buyer funds the buy.
            vm.broadcast(RESOLVER_KEY);
            mock.mint(counterparty, SEED_SETS * unit);
            vm.broadcast(RESOLVER_KEY);
            mock.mint(buyer, 100 * unit);
        }

        // --- Approvals: contract pulls USDC from counterparty (seed) + buyer (buy)
        vm.broadcast(COUNTERPARTY_KEY);
        IERC20Approve(address(usdc)).approve(address(market), type(uint256).max);
        vm.broadcast(BUYER_KEY);
        IERC20Approve(address(usdc)).approve(address(market), type(uint256).max);

        // --- Resolver wiring: market + signer + counterparty -----------------
        vm.broadcast(RESOLVER_KEY);
        market.createMarket(MARKET_ID);
        vm.broadcast(RESOLVER_KEY);
        market.setVoucherSigner(voucherSigner);
        vm.broadcast(RESOLVER_KEY);
        market.setCounterparty(counterparty);

        // --- Seed inventory: counterparty locks USDC for SEED_SETS complete sets
        vm.broadcast(RESOLVER_KEY);
        market.seedInventory(MARKET_ID, SEED_SETS);
        require(market.yesBalance(MARKET_ID, counterparty) == SEED_SETS, "seed YES");
        require(market.noBalance(MARKET_ID, counterparty) == SEED_SETS, "seed NO");
        require(usdc.balanceOf(address(market)) == SEED_SETS * unit, "backing == seeded sets");
        console2.log("  seeded sets:", SEED_SETS);

        // --- Voucher buy #1: YES, signed off-chain, submitted by the buyer ---
        uint256 yesCost = YES_BUY * unit; // nominal 1 USDC/share for the proof
        _voucherBuy(market, usdc, 1 /*YES*/, YES_BUY, yesCost, 0 /*nonce*/, buyer);
        require(market.yesBalance(MARKET_ID, buyer) == YES_BUY, "buyer YES credited");
        require(market.yesBalance(MARKET_ID, counterparty) == SEED_SETS - YES_BUY, "YES inventory debited");

        // --- Voucher buy #2: NO, exercises the other side + nonce advance ----
        uint256 noCost = NO_BUY * unit;
        _voucherBuy(market, usdc, 0 /*NO*/, NO_BUY, noCost, 1 /*nonce*/, buyer);
        require(market.noBalance(MARKET_ID, buyer) == NO_BUY, "buyer NO credited");
        require(market.nonces(buyer) == 2, "two vouchers consumed");
        console2.log("  bought YES:", YES_BUY);
        console2.log("  bought NO: ", NO_BUY);

        // Backing is unchanged by buys (shares move from already-backed inventory).
        require(usdc.balanceOf(address(market)) == SEED_SETS * unit, "backing unchanged by buys");

        // --- Resolve YES by the resolver -------------------------------------
        vm.broadcast(RESOLVER_KEY);
        market.resolve(MARKET_ID, CalibreMarket.Outcome.YES);
        console2.log("  resolved: YES");

        // After resolve, the NO side is worthless. The total outstanding WINNING
        // (YES) shares = buyer's YES + counterparty's residual YES = SEED_SETS.
        uint256 outstandingWinners = market.yesBalance(MARKET_ID, buyer) + market.yesBalance(MARKET_ID, counterparty);
        require(outstandingWinners == SEED_SETS, "winners == seeded sets");
        require(usdc.balanceOf(address(market)) == outstandingWinners * unit, "fully backed pre-redeem");

        // --- Redeem winners 1:1 ---------------------------------------------
        uint256 buyerBefore = usdc.balanceOf(buyer);
        vm.broadcast(BUYER_KEY);
        market.redeem(MARKET_ID);
        require(usdc.balanceOf(buyer) == buyerBefore + YES_BUY * unit, "buyer paid 1:1 on winning shares");
        require(market.yesBalance(MARKET_ID, buyer) == 0, "buyer winning shares burned");

        // Counterparty redeems its residual winning inventory; contract drains.
        uint256 cpBefore = usdc.balanceOf(counterparty);
        uint256 cpResidual = market.yesBalance(MARKET_ID, counterparty);
        vm.broadcast(COUNTERPARTY_KEY);
        market.redeem(MARKET_ID);
        require(usdc.balanceOf(counterparty) == cpBefore + cpResidual * unit, "counterparty residual paid 1:1");

        // --- Solvency: contract drains to EXACTLY zero -----------------------
        require(usdc.balanceOf(address(market)) == 0, "SOLVENT: drained to zero after all winners redeem");

        console2.log("== PASS: A-lite e2e round-trip solvent, drained to zero ==");
        console2.log("  custody verdict: A-lite CONFIRMED");
    }

    /// @dev Sign an EIP-712 voucher with the (known) signer key and submit it via
    ///      `buy` as the buyer — `msg.sender == q.buyer`, the A-lite custody path.
    function _voucherBuy(
        CalibreMarket market,
        IERC20, /*usdc*/
        uint8 side,
        uint256 size,
        uint256 cost,
        uint256 nonce,
        address buyer
    ) internal {
        CalibreMarket.Quote memory q = CalibreMarket.Quote({
            marketId: MARKET_ID,
            buyer: buyer,
            side: side,
            size: size,
            maxCost: cost, // the signed charge `buy` pulls (cost == maxCost)
            nonce: nonce,
            // A generous absolute expiry. The backend signer's real policy is
            // ~30s (W8 §5) and is unit-tested in CalibreVoucher.t.sol; a `forge
            // script` simulates then broadcasts across separately-mined blocks,
            // so `block.timestamp + 30` (evaluated at simulation time, then
            // signed) goes stale before the buy mines and reverts VoucherExpired.
            // The expiry is a signed field, so it can't be bumped after signing —
            // the proof uses a wide window to keep the round-trip deterministic.
            expiry: block.timestamp + 365 days
        });
        bytes32 digest = market.hashQuote(q);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RESOLVER_KEY, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.broadcast(BUYER_KEY);
        market.buy(q, sig);
    }
}
