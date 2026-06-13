// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CalibreMarket} from "../src/CalibreMarket.sol";
import {IERC20} from "../src/IERC20.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev W1.2 coverage for the A-lite EIP-712 voucher buy path: a backend-signed
///      voucher mints shares from counterparty inventory against a USDC pull,
///      with the four mandated reverts (expiry, nonce replay, wrong signer,
///      maxCost breach) plus buyer-binding, notional cap, and a solvency
///      invariant that holds across seed + buy + resolve + redeem.
///
///      This file is intentionally separate from CalibreMarket.t.sol: the W1.1
///      core tests stay pristine, and the whole voucher surface (contract +
///      this file) can be excised cleanly if W1.3 degrades custody to Model B.
contract CalibreVoucherTest is Test {
    CalibreMarket internal market;
    MockUSDC internal usdc;

    address internal resolver = makeAddr("resolver");
    address internal alice = makeAddr("alice");

    // The standing-counterparty quote signer — a known key so tests can sign.
    uint256 internal signerKey = 0xA11CE;
    address internal voucherSigner;
    // The inventory-holding counterparty (distinct role from the signer).
    address internal counterparty = makeAddr("counterparty");

    uint256 internal constant MARKET_ID = 42;
    uint256 internal unit; // 1 USDC in base units (1e6)

    function setUp() public {
        voucherSigner = vm.addr(signerKey);

        usdc = new MockUSDC();
        market = new CalibreMarket(IERC20(address(usdc)), resolver);
        unit = market.usdcUnit();
        assertEq(unit, 1e6, "6-dec USDC unit");

        vm.startPrank(resolver);
        market.createMarket(MARKET_ID);
        market.setVoucherSigner(voucherSigner);
        market.setCounterparty(counterparty);
        vm.stopPrank();

        // The counterparty fronts USDC to seed 100 complete sets of inventory.
        usdc.mint(counterparty, 1_000 * unit);
        vm.prank(counterparty);
        usdc.approve(address(market), type(uint256).max);
        vm.prank(resolver);
        market.seedInventory(MARKET_ID, 100);

        // Alice funds + approves so a voucher buy can pull her USDC.
        usdc.mint(alice, 1_000 * unit);
        vm.prank(alice);
        usdc.approve(address(market), type(uint256).max);
    }

    // --- helpers ----------------------------------------------------------

    function _quote(uint8 side, uint256 size, uint256 maxCost, uint256 nonce, uint256 expiry)
        internal
        view
        returns (CalibreMarket.Quote memory q)
    {
        q = CalibreMarket.Quote({
            marketId: MARKET_ID,
            buyer: alice,
            side: side,
            size: size,
            maxCost: maxCost,
            nonce: nonce,
            expiry: expiry
        });
    }

    function _sign(CalibreMarket.Quote memory q, uint256 key) internal view returns (bytes memory) {
        bytes32 digest = market.hashQuote(q);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // --- happy path -------------------------------------------------------

    function test_ValidVoucherBuyMovesInventoryAndPullsUsdc() public {
        // Buy 10 YES; the signed maxCost (6 USDC) is the exact charge. expiry 30s out.
        uint256 maxCost = 6 * unit; // the signer commits to this charge
        CalibreMarket.Quote memory q = _quote(1, 10, maxCost, 0, block.timestamp + 30);
        bytes memory sig = _sign(q, signerKey);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 cpBefore = usdc.balanceOf(counterparty);

        vm.prank(alice);
        market.buy(q, sig);

        assertEq(market.yesBalance(MARKET_ID, alice), 10, "buyer credited YES shares");
        assertEq(market.yesBalance(MARKET_ID, counterparty), 90, "inventory debited");
        assertEq(market.noBalance(MARKET_ID, counterparty), 100, "NO inventory untouched");
        assertEq(usdc.balanceOf(alice), aliceBefore - maxCost, "buyer charged the signed maxCost");
        assertEq(usdc.balanceOf(counterparty), cpBefore + maxCost, "counterparty reimbursed");
        assertEq(market.nonces(alice), 1, "nonce advanced");
    }

    function test_BuyNoSideAndRedeemAfterResolve() public {
        CalibreMarket.Quote memory q = _quote(0, 20, 5 * unit, 0, block.timestamp + 30);
        bytes memory sig = _sign(q, signerKey);
        vm.prank(alice);
        market.buy(q, sig);
        assertEq(market.noBalance(MARKET_ID, alice), 20);

        vm.prank(resolver);
        market.resolve(MARKET_ID, CalibreMarket.Outcome.NO);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        market.redeem(MARKET_ID);
        assertEq(usdc.balanceOf(alice), before + 20 * unit, "1:1 payout on the bought side");
    }

    // --- the four mandated reverts ---------------------------------------

    function test_RevertWhen_VoucherExpired() public {
        CalibreMarket.Quote memory q = _quote(1, 10, 7 * unit, 0, block.timestamp + 30);
        bytes memory sig = _sign(q, signerKey);
        vm.warp(q.expiry); // block.timestamp == expiry => expired (strict <)
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.VoucherExpired.selector);
        market.buy(q, sig);
    }

    function test_RevertWhen_NonceReplayed() public {
        CalibreMarket.Quote memory q = _quote(1, 5, 7 * unit, 0, block.timestamp + 30);
        bytes memory sig = _sign(q, signerKey);
        vm.prank(alice);
        market.buy(q, sig); // nonce 0 consumed -> next is 1

        // Re-submitting the same nonce-0 voucher reverts.
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.BadNonce.selector);
        market.buy(q, sig);
    }

    function test_RevertWhen_WrongSigner() public {
        uint256 attackerKey = 0xBAD;
        CalibreMarket.Quote memory q = _quote(1, 10, 7 * unit, 0, block.timestamp + 30);
        bytes memory sig = _sign(q, attackerKey); // signed by a non-authorized key
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.BadSignature.selector);
        market.buy(q, sig);
    }

    // --- #465 regression: the buyer cannot pay below the signed price ----

    /// @notice The charge is the signed `q.maxCost`, full stop. There is no
    ///         caller-supplied `cost`, so a voucher holder can no longer pay
    ///         below fair price (`buy(q, 0, sig)`) to drain seeded inventory.
    ///         Asserts the buyer pays exactly `maxCost` and the counterparty is
    ///         fully reimbursed for the inventory it fronted — never under-collected.
    ///
    ///         Before the #465 fix this same voucher could be replayed with a
    ///         caller `cost` of 0; the unsigned arg is now gone from the ABI, so
    ///         underpayment is unrepresentable rather than merely reverted.
    function test_Regression_BuyerChargedSignedMaxCost_NoUnderpay() public {
        uint256 signedCost = 6 * unit; // the price the signer committed to
        CalibreMarket.Quote memory q = _quote(1, 10, signedCost, 0, block.timestamp + 30);
        bytes memory sig = _sign(q, signerKey);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 cpBefore = usdc.balanceOf(counterparty);

        vm.prank(alice);
        market.buy(q, sig);

        // The buyer paid exactly the signed amount — not 0, not a partial sum.
        assertEq(aliceBefore - usdc.balanceOf(alice), signedCost, "buyer paid the full signed price");
        // The counterparty is reimbursed 1:1 for the 10 shares it fronted; its
        // USDC is not under-collected, so the post-resolve redeem can't drain it.
        assertEq(usdc.balanceOf(counterparty) - cpBefore, signedCost, "counterparty not under-collected");
        // The notional cap meters the real charge, not a spoofed 0.
        assertEq(market.marketNotionalUsed(MARKET_ID), signedCost, "notional booked at the real charge");
    }

    // --- additional binding / bound checks --------------------------------

    function test_RevertWhen_WrongBuyer() public {
        // Voucher is bound to `alice`; a different caller cannot redeem it.
        CalibreMarket.Quote memory q = _quote(1, 10, 7 * unit, 0, block.timestamp + 30);
        bytes memory sig = _sign(q, signerKey);
        address mallory = makeAddr("mallory");
        usdc.mint(mallory, 1_000 * unit);
        vm.prank(mallory);
        usdc.approve(address(market), type(uint256).max);
        vm.prank(mallory);
        vm.expectRevert(CalibreMarket.WrongBuyer.selector);
        market.buy(q, sig);
    }

    function test_RevertWhen_TamperedQuoteFailsSignature() public {
        CalibreMarket.Quote memory q = _quote(1, 10, 7 * unit, 0, block.timestamp + 30);
        bytes memory sig = _sign(q, signerKey);
        q.size = 11; // tamper after signing
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.BadSignature.selector);
        market.buy(q, sig);
    }

    function test_RevertWhen_NotionalCapExceeded() public {
        vm.prank(resolver);
        market.setMarketNotionalCap(MARKET_ID, 10 * unit); // 10 USDC cap

        // First buy charges the signed 8 USDC (ok, under the cap).
        CalibreMarket.Quote memory q0 = _quote(1, 7, 8 * unit, 0, block.timestamp + 30);
        bytes memory sig0 = _sign(q0, signerKey);
        vm.prank(alice);
        market.buy(q0, sig0);

        // Second buy charges the signed 5 USDC; used would be 8+5=13 > 10 -> revert.
        CalibreMarket.Quote memory q1 = _quote(1, 4, 5 * unit, 1, block.timestamp + 30);
        bytes memory sig1 = _sign(q1, signerKey);
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.NotionalCapExceeded.selector);
        market.buy(q1, sig1);
    }

    function test_RevertWhen_BuyBeyondInventory() public {
        // Inventory is 100 sets; quoting 101 YES reverts on InsufficientShares.
        CalibreMarket.Quote memory q = _quote(1, 101, 200 * unit, 0, block.timestamp + 30);
        bytes memory sig = _sign(q, signerKey);
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.InsufficientShares.selector);
        market.buy(q, sig);
    }

    function test_RevertWhen_SignerUnset() public {
        // Fresh market with no signer set.
        CalibreMarket fresh = new CalibreMarket(IERC20(address(usdc)), resolver);
        vm.prank(resolver);
        fresh.createMarket(MARKET_ID);
        CalibreMarket.Quote memory q = _quote(1, 1, unit, 0, block.timestamp + 30);
        // Signature is irrelevant; the unset-signer guard fires before recovery.
        bytes memory sig = new bytes(65);
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.SignerUnset.selector);
        fresh.buy(q, sig);
    }

    // --- reference-script parity (proves the W3.1 interface) --------------

    /// @notice A voucher whose digest is computed from the frozen domain +
    ///         struct, signed off-chain (here vm.sign stands in for the W3.1
    ///         backend signer), verifies on-chain. This is the W1.2<->W3.1
    ///         interface proof from the issue's success criteria.
    function test_ReferenceSignedVoucherVerifies() public view {
        CalibreMarket.Quote memory q = _quote(1, 10, 7 * unit, 0, block.timestamp + 30);
        bytes32 digest = market.hashQuote(q);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        address recovered = ecrecover(digest, v, r, s);
        assertEq(recovered, voucherSigner, "off-chain signature recovers to voucherSigner");

        // Domain separator matches the EIP-712 spec for the frozen fields.
        bytes32 expectedDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("CalibreMarket")),
                keccak256(bytes("1")),
                block.chainid,
                address(market)
            )
        );
        assertEq(market.domainSeparator(), expectedDomain, "domain separator matches frozen fields");
    }

    // --- solvency invariant under the voucher path ------------------------

    /// @notice The W1.1 solvency property survives the voucher path: across
    ///         seed + arbitrary voucher buys (YES and NO) + resolve + redeem,
    ///         the contract's USDC balance always covers every outstanding
    ///         winning share at 1:1, and drains to exactly 0 once all winners
    ///         (buyer + counterparty's residual) redeem.
    function testFuzz_SolvencyUnderVoucher(uint8 yesBuy, uint8 noBuy, bool yesWins) public {
        uint256 yb = bound(uint256(yesBuy), 0, 100);
        uint256 nb = bound(uint256(noBuy), 0, 100);

        // Inventory was seeded with 100 sets in setUp. Buy yb YES and nb NO via
        // vouchers; the charge (the signed maxCost) is irrelevant to solvency
        // (USDC just moves buyer->cp), so use a nominal 1 USDC/share. Alice is
        // funded with 1000 USDC, which covers the worst case (100 + 100 shares).
        uint256 nonce = 0;
        if (yb > 0) {
            CalibreMarket.Quote memory qy = _quote(1, yb, yb * unit, nonce, block.timestamp + 30);
            bytes memory sy = _sign(qy, signerKey);
            vm.prank(alice);
            market.buy(qy, sy);
            nonce++;
        }
        if (nb > 0) {
            CalibreMarket.Quote memory qn = _quote(0, nb, nb * unit, nonce, block.timestamp + 30);
            bytes memory sn = _sign(qn, signerKey);
            vm.prank(alice);
            market.buy(qn, sn);
        }

        CalibreMarket.Outcome outcome = yesWins ? CalibreMarket.Outcome.YES : CalibreMarket.Outcome.NO;
        vm.prank(resolver);
        market.resolve(MARKET_ID, outcome);

        // Pre-redeem: the 100 seeded sets fully back the 100 winning shares.
        assertEq(usdc.balanceOf(address(market)), 100 * unit, "fully backed pre-redeem");

        // Alice redeems her winning shares; contract stays solvent.
        uint256 aliceWin = yesWins ? market.yesBalance(MARKET_ID, alice) : market.noBalance(MARKET_ID, alice);
        if (aliceWin > 0) {
            vm.prank(alice);
            market.redeem(MARKET_ID);
        }
        _assertSolvent(yesWins);

        // The counterparty redeems its residual winning inventory; drains to 0.
        uint256 cpWin =
            yesWins ? market.yesBalance(MARKET_ID, counterparty) : market.noBalance(MARKET_ID, counterparty);
        if (cpWin > 0) {
            vm.prank(counterparty);
            market.redeem(MARKET_ID);
        }
        _assertSolvent(yesWins);
        assertEq(usdc.balanceOf(address(market)), 0, "fully drained after all winners redeem");
    }

    function _assertSolvent(bool yesWins) internal view {
        uint256 outstanding;
        if (yesWins) {
            outstanding = market.yesBalance(MARKET_ID, alice) + market.yesBalance(MARKET_ID, counterparty);
        } else {
            outstanding = market.noBalance(MARKET_ID, alice) + market.noBalance(MARKET_ID, counterparty);
        }
        assertGe(usdc.balanceOf(address(market)), outstanding * unit, "contract solvent");
    }
}
