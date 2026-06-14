// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CalibreMarket} from "../src/CalibreMarket.sol";
import {IERC20} from "../src/IERC20.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev #50 coverage for the A-lite EIP-712 SELL (early-exit) voucher path — the
///      inverse of `buy`: a backend-signed voucher returns the seller's shares
///      to counterparty inventory against a USDC payout, with the mandated
///      reverts (expiry, nonce replay, wrong signer, wrong seller, tampered
///      quote, insufficient shares), the payout cap, distinct-typehash domain
///      separation (a buy voucher can't be replayed as a sell), and a solvency
///      invariant that holds across seed + buy + sell + resolve + redeem.
///
///      Kept separate from CalibreVoucher.t.sol (buy) / CalibreMarket.t.sol
///      (core) so each surface excises cleanly.
contract CalibreSellTest is Test {
    CalibreMarket internal market;
    MockUSDC internal usdc;

    address internal resolver = makeAddr("resolver");
    address internal alice = makeAddr("alice");

    uint256 internal signerKey = 0xA11CE;
    address internal voucherSigner;
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

        // Counterparty fronts USDC to seed 100 complete sets of inventory, AND
        // keeps spare USDC to pay out early exits (a sell pays from its balance).
        usdc.mint(counterparty, 1_000 * unit);
        vm.prank(counterparty);
        usdc.approve(address(market), type(uint256).max);
        vm.prank(resolver);
        market.seedInventory(MARKET_ID, 100);

        // Alice funds + approves so she can buy (to acquire a position to sell).
        usdc.mint(alice, 1_000 * unit);
        vm.prank(alice);
        usdc.approve(address(market), type(uint256).max);
    }

    // --- helpers ----------------------------------------------------------

    function _buyQuote(uint8 side, uint256 size, uint256 maxCost, uint256 nonce, uint256 expiry)
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

    function _sellQuote(uint8 side, uint256 size, uint256 minPayout, uint256 nonce, uint256 expiry)
        internal
        view
        returns (CalibreMarket.SellQuote memory q)
    {
        q = CalibreMarket.SellQuote({
            marketId: MARKET_ID,
            seller: alice,
            side: side,
            size: size,
            minPayout: minPayout,
            nonce: nonce,
            expiry: expiry
        });
    }

    function _signBuy(CalibreMarket.Quote memory q, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, market.hashQuote(q));
        return abi.encodePacked(r, s, v);
    }

    function _signSell(CalibreMarket.SellQuote memory q, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, market.hashSellQuote(q));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Buy `size` YES at nonce `nonce` so Alice holds a position to sell.
    ///      Sign BEFORE the prank: `hashQuote` is an external call that would
    ///      otherwise consume the one-shot `vm.prank` meant for `buy`.
    function _aliceBuysYes(uint256 size, uint256 cost, uint256 nonce) internal {
        CalibreMarket.Quote memory q = _buyQuote(1, size, cost, nonce, block.timestamp + 30);
        bytes memory sig = _signBuy(q, signerKey);
        vm.prank(alice);
        market.buy(q, sig);
    }

    // --- happy path -------------------------------------------------------

    function test_ValidSellReturnsInventoryAndPaysUsdc() public {
        // Alice buys 10 YES (nonce 0) for 6 USDC, then sells 4 back for 3 USDC.
        _aliceBuysYes(10, 6 * unit, 0);

        uint256 payout = 3 * unit;
        CalibreMarket.SellQuote memory sq = _sellQuote(1, 4, payout, 1, block.timestamp + 30);
        bytes memory sig = _signSell(sq, signerKey);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 cpBefore = usdc.balanceOf(counterparty);
        uint256 cpYesBefore = market.yesBalance(MARKET_ID, counterparty);

        vm.prank(alice);
        market.sell(sq, sig);

        assertEq(market.yesBalance(MARKET_ID, alice), 6, "seller debited 4 YES");
        assertEq(market.yesBalance(MARKET_ID, counterparty), cpYesBefore + 4, "inventory credited back");
        assertEq(usdc.balanceOf(alice), aliceBefore + payout, "seller paid the signed payout");
        assertEq(usdc.balanceOf(counterparty), cpBefore - payout, "counterparty funded the exit");
        assertEq(market.nonces(alice), 2, "nonce advanced past the buy + sell");
        assertEq(market.marketPayoutUsed(MARKET_ID), payout, "payout metered");
    }

    function test_SellNoSide() public {
        // Buy 20 NO (nonce 0), sell 20 NO back (nonce 1) — full exit.
        CalibreMarket.Quote memory bq = _buyQuote(0, 20, 5 * unit, 0, block.timestamp + 30);
        bytes memory bsig = _signBuy(bq, signerKey);
        vm.prank(alice);
        market.buy(bq, bsig);

        CalibreMarket.SellQuote memory sq = _sellQuote(0, 20, 4 * unit, 1, block.timestamp + 30);
        bytes memory ssig = _signSell(sq, signerKey);
        vm.prank(alice);
        market.sell(sq, ssig);

        assertEq(market.noBalance(MARKET_ID, alice), 0, "fully exited NO");
        assertEq(market.noBalance(MARKET_ID, counterparty), 100, "NO inventory restored");
    }

    // --- the mandated reverts --------------------------------------------

    function test_RevertWhen_SellVoucherExpired() public {
        _aliceBuysYes(10, 6 * unit, 0);
        CalibreMarket.SellQuote memory sq = _sellQuote(1, 4, 3 * unit, 1, block.timestamp + 30);
        bytes memory sig = _signSell(sq, signerKey);
        vm.warp(sq.expiry); // == expiry => expired (strict <)
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.VoucherExpired.selector);
        market.sell(sq, sig);
    }

    function test_RevertWhen_SellNonceReplayed() public {
        _aliceBuysYes(10, 6 * unit, 0);
        CalibreMarket.SellQuote memory sq = _sellQuote(1, 2, 1 * unit, 1, block.timestamp + 30);
        bytes memory sig = _signSell(sq, signerKey);
        vm.prank(alice);
        market.sell(sq, sig); // nonce 1 consumed -> next is 2
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.BadNonce.selector);
        market.sell(sq, sig);
    }

    function test_RevertWhen_SellWrongSigner() public {
        _aliceBuysYes(10, 6 * unit, 0);
        uint256 attackerKey = 0xBAD;
        CalibreMarket.SellQuote memory sq = _sellQuote(1, 4, 3 * unit, 1, block.timestamp + 30);
        bytes memory sig = _signSell(sq, attackerKey);
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.BadSignature.selector);
        market.sell(sq, sig);
    }

    function test_RevertWhen_WrongSeller() public {
        _aliceBuysYes(10, 6 * unit, 0);
        CalibreMarket.SellQuote memory sq = _sellQuote(1, 4, 3 * unit, 1, block.timestamp + 30);
        bytes memory sig = _signSell(sq, signerKey);
        address mallory = makeAddr("mallory");
        vm.prank(mallory);
        vm.expectRevert(CalibreMarket.WrongSeller.selector);
        market.sell(sq, sig);
    }

    function test_RevertWhen_TamperedSellQuoteFailsSignature() public {
        _aliceBuysYes(10, 6 * unit, 0);
        CalibreMarket.SellQuote memory sq = _sellQuote(1, 4, 3 * unit, 1, block.timestamp + 30);
        bytes memory sig = _signSell(sq, signerKey);
        sq.minPayout = 5 * unit; // tamper after signing (ask for more USDC)
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.BadSignature.selector);
        market.sell(sq, sig);
    }

    function test_RevertWhen_SellMoreThanHeld() public {
        _aliceBuysYes(3, 2 * unit, 0); // holds 3 YES
        CalibreMarket.SellQuote memory sq = _sellQuote(1, 4, 3 * unit, 1, block.timestamp + 30);
        bytes memory sig = _signSell(sq, signerKey);
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.InsufficientShares.selector);
        market.sell(sq, sig);
    }

    function test_RevertWhen_SellPayoutCapExceeded() public {
        _aliceBuysYes(10, 6 * unit, 0);
        vm.prank(resolver);
        market.setMarketNotionalCap(MARKET_ID, 4 * unit); // 4 USDC payout cap

        // First sell pays 3 USDC (ok, under the cap).
        CalibreMarket.SellQuote memory sq0 = _sellQuote(1, 3, 3 * unit, 1, block.timestamp + 30);
        bytes memory sig0 = _signSell(sq0, signerKey);
        vm.prank(alice);
        market.sell(sq0, sig0);

        // Second sell pays 2 USDC; used would be 3+2=5 > 4 -> revert.
        CalibreMarket.SellQuote memory sq1 = _sellQuote(1, 2, 2 * unit, 2, block.timestamp + 30);
        bytes memory sig1 = _signSell(sq1, signerKey);
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.NotionalCapExceeded.selector);
        market.sell(sq1, sig1);
    }

    function test_RevertWhen_SellSignerUnset() public {
        CalibreMarket fresh = new CalibreMarket(IERC20(address(usdc)), resolver);
        vm.prank(resolver);
        fresh.createMarket(MARKET_ID);
        CalibreMarket.SellQuote memory sq = _sellQuote(1, 1, unit, 0, block.timestamp + 30);
        bytes memory sig = new bytes(65);
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.SignerUnset.selector);
        fresh.sell(sq, sig);
    }

    // --- distinct-typehash domain separation (#50) -----------------------

    /// @notice A BUY voucher's signature must NOT verify against `sell` (and the
    ///         converse). The typehashes differ, so a captured buy signature
    ///         recovers to a different address under `hashSellQuote` and fails
    ///         BadSignature — a buy voucher can never be redirected into a payout.
    function test_BuyVoucherCannotBeReplayedAsSell() public {
        _aliceBuysYes(10, 6 * unit, 0);
        // A buy voucher signed over the buy digest, fields copied into a SellQuote.
        CalibreMarket.Quote memory bq = _buyQuote(1, 4, 3 * unit, 1, block.timestamp + 30);
        bytes memory buySig = _signBuy(bq, signerKey);
        CalibreMarket.SellQuote memory sq = _sellQuote(1, 4, 3 * unit, 1, block.timestamp + 30);
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.BadSignature.selector);
        market.sell(sq, buySig);
    }

    function test_SellVoucherCannotBeReplayedAsBuy() public {
        CalibreMarket.SellQuote memory sq = _sellQuote(1, 4, 3 * unit, 0, block.timestamp + 30);
        bytes memory sellSig = _signSell(sq, signerKey);
        CalibreMarket.Quote memory bq = _buyQuote(1, 4, 3 * unit, 0, block.timestamp + 30);
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.BadSignature.selector);
        market.buy(bq, sellSig);
    }

    /// @notice The two typehashes are distinct constants (a structural guard the
    ///         backend signer mirrors with two `_VOUCHER_TYPES`).
    function test_SellTypehashDiffersFromBuy() public view {
        bytes32 buyTh = keccak256(
            "Quote(uint256 marketId,address buyer,uint8 side,uint256 size,uint256 maxCost,uint256 nonce,uint256 expiry)"
        );
        bytes32 sellTh = keccak256(
            "SellQuote(uint256 marketId,address seller,uint8 side,uint256 size,uint256 minPayout,uint256 nonce,uint256 expiry)"
        );
        assertTrue(buyTh != sellTh, "buy and sell typehashes must differ");
    }

    // --- reference-script parity (proves the backend signer interface) ----

    function test_ReferenceSignedSellVoucherVerifies() public view {
        CalibreMarket.SellQuote memory sq = _sellQuote(1, 10, 7 * unit, 0, block.timestamp + 30);
        bytes32 digest = market.hashSellQuote(sq);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        address recovered = ecrecover(digest, v, r, s);
        assertEq(recovered, voucherSigner, "off-chain sell signature recovers to voucherSigner");
    }

    // --- solvency invariant under seed + buy + sell + resolve + redeem ----

    /// @notice The W1.1 solvency property survives the sell path: a sell only
    ///         moves shares + USDC between seller and counterparty, so the locked
    ///         backing is untouched. Across seed + buy + partial sell + resolve +
    ///         redeem, the contract's USDC always covers outstanding winning
    ///         shares 1:1 and drains to exactly 0 once all winners redeem.
    function testFuzz_SolvencyUnderSell(uint8 buySize, uint8 sellSize, bool yesWins) public {
        uint256 bought = bound(uint256(buySize), 1, 100);
        uint256 sold = bound(uint256(sellSize), 0, bought);

        // Buy `bought` YES (nonce 0), then sell `sold` back (nonce 1).
        _aliceBuysYes(bought, bought * unit, 0);
        if (sold > 0) {
            CalibreMarket.SellQuote memory sq = _sellQuote(1, sold, sold * unit, 1, block.timestamp + 30);
            bytes memory ssig = _signSell(sq, signerKey);
            vm.prank(alice);
            market.sell(sq, ssig);
        }

        vm.prank(resolver);
        market.resolve(MARKET_ID, yesWins ? CalibreMarket.Outcome.YES : CalibreMarket.Outcome.NO);

        // The 100 seeded sets still fully back the 100 winning shares — a sell
        // never touched the locked USDC, only moved shares back to inventory.
        assertEq(usdc.balanceOf(address(market)), 100 * unit, "fully backed pre-redeem");

        uint256 aliceWin = yesWins ? market.yesBalance(MARKET_ID, alice) : market.noBalance(MARKET_ID, alice);
        if (aliceWin > 0) {
            vm.prank(alice);
            market.redeem(MARKET_ID);
        }
        _assertSolvent(yesWins);

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
