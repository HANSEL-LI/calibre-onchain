// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CalibreMarket} from "../src/CalibreMarket.sol";
import {IERC20} from "../src/IERC20.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev W1.1 coverage for the custody-independent settlement core: mint /
///      resolve / redeem happy path, the solvency invariant, and access control.
contract CalibreMarketTest is Test {
    CalibreMarket internal market;
    MockUSDC internal usdc;

    address internal resolver = makeAddr("resolver");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant MARKET_ID = 42;
    uint256 internal unit; // 1 USDC in base units (1e6)

    function setUp() public {
        usdc = new MockUSDC();
        market = new CalibreMarket(IERC20(address(usdc)), resolver);
        unit = market.usdcUnit();

        assertEq(unit, 1e6, "6-dec USDC unit");

        // Fund Alice and Bob and approve the market to pull on mint.
        usdc.mint(alice, 1_000 * unit);
        usdc.mint(bob, 1_000 * unit);
        vm.prank(alice);
        usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(market), type(uint256).max);

        vm.prank(resolver);
        market.createMarket(MARKET_ID);
    }

    // --- happy path -------------------------------------------------------

    function test_MintLocksUsdcAndCreditsBothSides() public {
        vm.prank(alice);
        market.mint(MARKET_ID, 10);

        assertEq(market.yesBalance(MARKET_ID, alice), 10);
        assertEq(market.noBalance(MARKET_ID, alice), 10);
        assertEq(usdc.balanceOf(address(market)), 10 * unit, "contract holds locked USDC");
        assertEq(usdc.balanceOf(alice), 990 * unit, "alice paid 10 USDC");
    }

    function test_ResolveThenRedeemWinningSide() public {
        vm.prank(alice);
        market.mint(MARKET_ID, 10);

        vm.prank(resolver);
        market.resolve(MARKET_ID, CalibreMarket.Outcome.YES);

        uint256 beforeBal = usdc.balanceOf(alice);
        vm.prank(alice);
        market.redeem(MARKET_ID);

        assertEq(market.yesBalance(MARKET_ID, alice), 0, "winning shares burned");
        assertEq(usdc.balanceOf(alice), beforeBal + 10 * unit, "1:1 USDC payout");
        // NO shares remain but are worthless: a second redeem finds nothing.
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.NothingToRedeem.selector);
        market.redeem(MARKET_ID);
    }

    function test_TransferShares() public {
        vm.prank(alice);
        market.mint(MARKET_ID, 10);

        vm.prank(alice);
        market.transferShares(MARKET_ID, true, bob, 4);

        assertEq(market.yesBalance(MARKET_ID, alice), 6);
        assertEq(market.yesBalance(MARKET_ID, bob), 4);
        assertEq(market.noBalance(MARKET_ID, alice), 10, "NO side untouched");
    }

    function test_TransferredSharesRedeemForNewHolder() public {
        vm.prank(alice);
        market.mint(MARKET_ID, 10);
        vm.prank(alice);
        market.transferShares(MARKET_ID, true, bob, 4);

        vm.prank(resolver);
        market.resolve(MARKET_ID, CalibreMarket.Outcome.YES);

        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        market.redeem(MARKET_ID);
        assertEq(usdc.balanceOf(bob), bobBefore + 4 * unit);
    }

    function test_SetResolverHandoff() public {
        address backend = makeAddr("backend");
        vm.prank(resolver);
        market.setResolver(backend);
        assertEq(market.resolver(), backend);

        // Old resolver can no longer resolve; new one can.
        vm.prank(resolver);
        vm.expectRevert(CalibreMarket.NotResolver.selector);
        market.resolve(MARKET_ID, CalibreMarket.Outcome.NO);

        vm.prank(backend);
        market.resolve(MARKET_ID, CalibreMarket.Outcome.NO);
        (, CalibreMarket.Outcome outcome) = market.markets(MARKET_ID);
        assertEq(uint256(outcome), uint256(CalibreMarket.Outcome.NO));
    }

    // --- reverts / access control ----------------------------------------

    function test_RevertWhen_DoubleResolve() public {
        vm.prank(resolver);
        market.resolve(MARKET_ID, CalibreMarket.Outcome.YES);
        vm.prank(resolver);
        vm.expectRevert(CalibreMarket.AlreadyResolved.selector);
        market.resolve(MARKET_ID, CalibreMarket.Outcome.NO);
    }

    function test_RevertWhen_RedeemBeforeResolve() public {
        vm.prank(alice);
        market.mint(MARKET_ID, 5);
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.NotResolved.selector);
        market.redeem(MARKET_ID);
    }

    function test_RevertWhen_NonResolverCreates() public {
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.NotResolver.selector);
        market.createMarket(999);
    }

    function test_RevertWhen_NonResolverResolves() public {
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.NotResolver.selector);
        market.resolve(MARKET_ID, CalibreMarket.Outcome.YES);
    }

    function test_RevertWhen_MintUnknownMarket() public {
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.UnknownMarket.selector);
        market.mint(12345, 1);
    }

    function test_RevertWhen_MintZeroSets() public {
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.ZeroSets.selector);
        market.mint(MARKET_ID, 0);
    }

    function test_RevertWhen_ResolveUnresolvedOutcome() public {
        vm.prank(resolver);
        vm.expectRevert(CalibreMarket.InvalidOutcome.selector);
        market.resolve(MARKET_ID, CalibreMarket.Outcome.UNRESOLVED);
    }

    function test_RevertWhen_TransferMoreThanHeld() public {
        vm.prank(alice);
        market.mint(MARKET_ID, 1);
        vm.prank(alice);
        vm.expectRevert(CalibreMarket.InsufficientShares.selector);
        market.transferShares(MARKET_ID, true, bob, 2);
    }

    function test_RevertWhen_ZeroAddressConstructorArgs() public {
        vm.expectRevert(CalibreMarket.ZeroAddress.selector);
        new CalibreMarket(IERC20(address(0)), resolver);
        vm.expectRevert(CalibreMarket.ZeroAddress.selector);
        new CalibreMarket(IERC20(address(usdc)), address(0));
    }

    // --- solvency invariant ----------------------------------------------

    /// @notice Across arbitrary mint / transfer / resolve / redeem sequences the
    ///         contract's USDC balance always covers every outstanding winning
    ///         share at 1:1. Solvent by construction.
    function testFuzz_SolvencyInvariant(uint8 aliceSets, uint8 bobSets, uint8 xfer, bool yesWins, bool aliceRedeems)
        public
    {
        aliceSets = uint8(bound(aliceSets, 1, 100));
        bobSets = uint8(bound(bobSets, 1, 100));

        vm.prank(alice);
        market.mint(MARKET_ID, aliceSets);
        vm.prank(bob);
        market.mint(MARKET_ID, bobSets);

        // Move some winning-side shares from alice to bob (bounded by holdings).
        uint256 moved = bound(uint256(xfer), 0, aliceSets);
        if (moved > 0) {
            vm.prank(alice);
            market.transferShares(MARKET_ID, yesWins, bob, moved);
        }

        CalibreMarket.Outcome outcome = yesWins ? CalibreMarket.Outcome.YES : CalibreMarket.Outcome.NO;
        vm.prank(resolver);
        market.resolve(MARKET_ID, outcome);

        // Before any redeem: locked USDC == total winning shares * unit
        // (each side minted exactly `sets` shares, so winning side total == sets sum).
        uint256 totalWinning = uint256(aliceSets) + uint256(bobSets);
        assertEq(usdc.balanceOf(address(market)), totalWinning * unit, "fully backed pre-redeem");
        _assertSolvent(yesWins);

        // One holder redeems; the contract stays solvent for the remainder.
        address redeemer = aliceRedeems ? alice : bob;
        uint256 winShares = yesWins ? market.yesBalance(MARKET_ID, redeemer) : market.noBalance(MARKET_ID, redeemer);
        if (winShares > 0) {
            vm.prank(redeemer);
            market.redeem(MARKET_ID);
        }
        _assertSolvent(yesWins);
    }

    /// @dev contract USDC balance >= sum of outstanding winning shares * unit.
    function _assertSolvent(bool yesWins) internal view {
        uint256 outstanding;
        if (yesWins) {
            outstanding = market.yesBalance(MARKET_ID, alice) + market.yesBalance(MARKET_ID, bob);
        } else {
            outstanding = market.noBalance(MARKET_ID, alice) + market.noBalance(MARKET_ID, bob);
        }
        assertGe(usdc.balanceOf(address(market)), outstanding * unit, "contract solvent");
    }
}
