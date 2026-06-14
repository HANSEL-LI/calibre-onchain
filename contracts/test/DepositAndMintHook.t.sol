// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CalibreMarket} from "../src/CalibreMarket.sol";
import {DepositAndMintHook} from "../src/DepositAndMintHook.sol";
import {IERC20} from "../src/IERC20.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockHookRelay} from "./mocks/MockHookRelay.sol";
import {MockFalseTransferUSDC} from "./mocks/MockFalseTransferUSDC.sol";

/// @dev #613 coverage for the CCTP V2 bridge-and-mint-on-arrival hook. Drives the
///      real DepositAndMintHook through a mock relay that reproduces Circle's
///      CCTPHookWrapper flow (mint USDC to the hook, then `target.call(hookData)`),
///      asserting a complete set lands on the recipient and the USDC is locked in
///      CalibreMarket. Covers dust refund and the no-full-set / zero-recipient
///      revert paths.
contract DepositAndMintHookTest is Test {
    CalibreMarket internal market;
    DepositAndMintHook internal hook;
    MockUSDC internal usdc;
    MockHookRelay internal relay;

    address internal resolver = makeAddr("resolver");
    address internal alice = makeAddr("alice"); // the bridging user / recipient

    uint256 internal constant MARKET_ID = 7;
    uint256 internal unit; // 1 USDC in base units (1e6)

    function setUp() public {
        usdc = new MockUSDC();
        market = new CalibreMarket(IERC20(address(usdc)), resolver);
        hook = new DepositAndMintHook(market);
        relay = new MockHookRelay(usdc);
        unit = market.usdcUnit();

        assertEq(unit, 1e6, "6-dec USDC unit");
        assertEq(address(hook.usdc()), address(usdc), "hook reads market's USDC");
        assertEq(address(hook.market()), address(market), "hook wired to market");

        vm.prank(resolver);
        market.createMarket(MARKET_ID);
    }

    /// @dev Encode the CCTP hook payload exactly as a source-chain burn would:
    ///      `mintRecipient`/`target` = the hook, hookCallData = depositAndMint(id, recipient).
    function _hookData(uint256 marketId, address recipient) internal view returns (bytes memory) {
        return abi.encodePacked(
            address(hook), abi.encodeCall(DepositAndMintHook.depositAndMint, (marketId, recipient))
        );
    }

    // --- happy path: bridge-and-mint through the relay ---------------------

    function test_RelayMintsCompleteSetToRecipient() public {
        uint256 bridged = 10 * unit; // exactly 10 USDC, no dust

        (bool hookSuccess,) = relay.relay(bridged, _hookData(MARKET_ID, alice));
        assertTrue(hookSuccess, "hook executed");

        // Recipient holds a full complete set.
        assertEq(market.yesBalance(MARKET_ID, alice), 10, "10 YES to recipient");
        assertEq(market.noBalance(MARKET_ID, alice), 10, "10 NO to recipient");
        // USDC is locked in the market, backing the set 1:1.
        assertEq(usdc.balanceOf(address(market)), 10 * unit, "market holds locked USDC");
        // Hook is a pass-through: holds no USDC and no shares afterward.
        assertEq(usdc.balanceOf(address(hook)), 0, "hook drained");
        assertEq(market.yesBalance(MARKET_ID, address(hook)), 0, "hook keeps no YES");
        assertEq(market.noBalance(MARKET_ID, address(hook)), 0, "hook keeps no NO");
    }

    // --- dust: non-exact bridge amount is refunded, not stranded -----------

    function test_DustRefundedToRecipient() public {
        uint256 dust = 123_456; // < 1 USDC
        uint256 bridged = 3 * unit + dust;

        vm.expectEmit(true, true, false, true, address(hook));
        emit DepositAndMintHook.DepositMinted(MARKET_ID, alice, 3, dust);
        relay.relay(bridged, _hookData(MARKET_ID, alice));

        assertEq(market.yesBalance(MARKET_ID, alice), 3, "3 YES minted");
        assertEq(market.noBalance(MARKET_ID, alice), 3, "3 NO minted");
        assertEq(usdc.balanceOf(alice), dust, "dust refunded to recipient");
        assertEq(usdc.balanceOf(address(market)), 3 * unit, "only whole sets locked");
        assertEq(usdc.balanceOf(address(hook)), 0, "hook fully drained");
    }

    // --- revert: less than one whole set bridged ---------------------------

    function test_RevertWhen_NothingToMint() public {
        uint256 stuck = unit - 1; // < 1 USDC, cannot fund a single set

        // The relay's low-level call swallows the revert (CCTP non-atomicity),
        // so hookSuccess is false and the USDC is parked on the hook.
        (bool hookSuccess,) = relay.relay(stuck, _hookData(MARKET_ID, alice));
        assertFalse(hookSuccess, "hook reverted, relay continued");
        assertEq(usdc.balanceOf(address(hook)), stuck, "USDC stuck on hook");

        // A direct call confirms the revert reason.
        vm.expectRevert(DepositAndMintHook.NothingToMint.selector);
        hook.depositAndMint(MARKET_ID, alice);

        // sweep is the escape hatch once enough arrives: top the hook over 1 unit
        // and flush whatever whole sets are now affordable to a recipient.
        usdc.mint(address(hook), 2); // now 1 USDC + 1 base unit on the hook
        hook.sweep(MARKET_ID, alice);
        assertEq(market.yesBalance(MARKET_ID, alice), 1, "swept 1 set to recipient");
        assertEq(usdc.balanceOf(alice), 1, "swept dust refunded");
        assertEq(usdc.balanceOf(address(hook)), 0, "hook drained by sweep");
    }

    // --- revert: zero recipient -------------------------------------------

    function test_RevertWhen_ZeroRecipient() public {
        usdc.mint(address(hook), 5 * unit);
        vm.expectRevert(DepositAndMintHook.ZeroAddress.selector);
        hook.depositAndMint(MARKET_ID, address(0));
    }

    // --- revert: unknown / unset market bubbles from CalibreMarket ---------

    function test_RevertWhen_UnknownMarket() public {
        usdc.mint(address(hook), 5 * unit);
        vm.expectRevert(CalibreMarket.UnknownMarket.selector);
        hook.depositAndMint(999, alice);
    }

    // --- relay-agnostic: a direct funded call equals the relayed result ----

    function test_DirectCallEquivalentToRelay() public {
        usdc.mint(address(hook), 4 * unit);
        uint256 sets = hook.depositAndMint(MARKET_ID, alice);

        assertEq(sets, 4, "returns sets minted");
        assertEq(market.yesBalance(MARKET_ID, alice), 4, "4 YES to recipient");
        assertEq(market.noBalance(MARKET_ID, alice), 4, "4 NO to recipient");
        assertEq(usdc.balanceOf(address(market)), 4 * unit, "USDC locked");
        assertEq(usdc.balanceOf(address(hook)), 0, "hook drained");
    }

    // --- revert: dust refund leg fails on a false-returning USDC -----------

    function test_RevertWhen_RefundReturnsFalse() public {
        // A USDC whose transfer() returns false without reverting. The mint path
        // (transferFrom/approve) still works, so the revert can only come from the
        // hook's `_refund` boolean check on the dust leg — exercising UsdcTransferFailed.
        MockFalseTransferUSDC badUsdc = new MockFalseTransferUSDC();
        CalibreMarket badMarket = new CalibreMarket(IERC20(address(badUsdc)), resolver);
        DepositAndMintHook badHook = new DepositAndMintHook(badMarket);

        vm.prank(resolver);
        badMarket.createMarket(MARKET_ID);

        // Fund with dust so `_refund` is reached (no dust → no refund → no revert).
        badUsdc.mint(address(badHook), 3 * unit + 50_000);

        vm.expectRevert(DepositAndMintHook.UsdcTransferFailed.selector);
        badHook.depositAndMint(MARKET_ID, alice);
    }

    // --- constructor guard -------------------------------------------------

    function test_RevertWhen_ZeroMarketConstructor() public {
        vm.expectRevert(DepositAndMintHook.ZeroAddress.selector);
        new DepositAndMintHook(CalibreMarket(address(0)));
    }
}
