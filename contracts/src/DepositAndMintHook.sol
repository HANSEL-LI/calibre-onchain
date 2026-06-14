// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";
import {CalibreMarket} from "./CalibreMarket.sol";

/// @title DepositAndMintHook
/// @notice CCTP V2 **destination Hook**: bridge-and-mint-on-arrival. A user
///         bridging USDC from any CCTP V2 chain (Arc = domain 26) into this
///         contract mints a complete set on `CalibreMarket` in the same
///         destination-side relay transaction, and both share legs are forwarded
///         to the recipient. Removes the "get USDC onto Arc first" onboarding
///         wall (#613).
///
/// @dev    HOW CCTP V2 HOOKS DRIVE THIS (researched against Circle's
///         `circlefin/evm-cctp-contracts`):
///         CCTP V2 does NOT auto-invoke a hook. `depositForBurnWithHook` on the
///         source chain carries a `hookData` blob inside the BurnMessageV2 body;
///         on the destination, `MessageTransmitterV2.receiveMessage` only mints
///         USDC to the burn's `mintRecipient`. A relayer then runs Circle's
///         reference `CCTPHookWrapper` (`src/examples/CCTPHookWrapper.sol`),
///         which parses `hookData` as `target(20B) ++ hookCallData(dynamic)` and
///         does `target.call(hookCallData)`.
///
///         INTEGRATION CONTRACT for a source-chain bridge to mint here:
///           - set the burn `mintRecipient` = address(this) (USDC lands here);
///           - set `hookData = abi.encodePacked(
///                 address(this),
///                 abi.encodeCall(DepositAndMintHook.depositAndMint,
///                                (chainMarketId, recipient)));`
///         After the mint, the wrapper calls `depositAndMint`, which finds the
///         bridged USDC already sitting in this contract's balance.
///
///         NON-ATOMICITY: the CCTP mint and the hook call are separate steps by
///         design — if the hook call fails, USDC is already minted to this
///         contract. Two guards keep funds safe: (a) dust below one whole set is
///         REFUNDED, never reverted, so a relay never strands the full amount;
///         (b) `sweep` is a permissionless escape hatch that flushes any stuck
///         balance to a recipient by minting/refunding. The contract holds no
///         funds between calls and is therefore ownerless: it can only ever mint
///         a fully-USDC-backed complete set and hand both legs to the
///         caller-named recipient (see Decisions in
///         `docs/plans/613-cctp-mint-hook.md`).
contract DepositAndMintHook {
    /// @notice The 6-decimal ERC-20 USDC token shares mint against. Read from the
    ///         injected market so the two can never disagree on the asset.
    IERC20 public immutable usdc;

    /// @notice The CalibreMarket this hook mints complete sets on. Injected at
    ///         construction (one hook per market core deployment).
    CalibreMarket public immutable market;

    /// @notice Emitted once a bridged deposit has minted a complete set.
    /// @param chainMarketId the market the set was minted on.
    /// @param recipient     who received the YES+NO legs (and any dust refund).
    /// @param sets          complete sets minted (== YES == NO shares forwarded).
    /// @param dust          sub-`usdcUnit` USDC remainder refunded to `recipient`.
    event DepositMinted(
        uint256 indexed chainMarketId, address indexed recipient, uint256 sets, uint256 dust
    );

    error ZeroAddress();
    error NothingToMint();
    error UsdcTransferFailed();

    /// @param market_ The deployed CalibreMarket to mint complete sets on.
    constructor(CalibreMarket market_) {
        if (address(market_) == address(0)) revert ZeroAddress();
        market = market_;
        usdc = market_.usdc();
    }

    /// @notice Mint a complete set from this contract's current USDC balance and
    ///         forward both legs to `recipient`. Called by a CCTP V2 hook relayer
    ///         (Circle's `CCTPHookWrapper`) after the bridged USDC has been minted
    ///         into this contract; the encoded `hookCallData` is a call to this
    ///         function. Also callable directly once the contract is funded
    ///         (relay-agnostic).
    /// @dev    `sets` is derived from the *actual* balance, not an encoded amount,
    ///         so a fast-path executor fee can't desync the math — whatever
    ///         arrived is what's minted. Any sub-`usdcUnit` remainder is refunded
    ///         to `recipient` rather than stranding the whole amount on a non-exact
    ///         bridge value (the CCTP mint is irreversible).
    /// @param chainMarketId the market to mint the complete set on.
    /// @param recipient     who receives the `sets` YES + `sets` NO shares.
    /// @return sets         complete sets minted and forwarded.
    function depositAndMint(uint256 chainMarketId, address recipient) external returns (uint256 sets) {
        return _depositAndMint(chainMarketId, recipient);
    }

    /// @notice Escape hatch for funds stuck here after a non-atomic relay (e.g. a
    ///         hook call that reverted with `NothingToMint`, or a stray transfer).
    ///         Permissionless: it can only mint a fully-backed complete set to
    ///         `recipient` and refund the remainder — there is nothing to steal.
    /// @param chainMarketId the market to mint any whole sets on.
    /// @param recipient     who receives the minted legs + any dust.
    function sweep(uint256 chainMarketId, address recipient) external returns (uint256 sets) {
        return _depositAndMint(chainMarketId, recipient);
    }

    /// @dev Shared mint-and-forward body for `depositAndMint` / `sweep`. Derives
    ///      `sets` from the contract's actual USDC balance.
    function _depositAndMint(uint256 chainMarketId, address recipient) internal returns (uint256 sets) {
        if (recipient == address(0)) revert ZeroAddress();

        uint256 unit = market.usdcUnit();
        uint256 balance = usdc.balanceOf(address(this));
        sets = balance / unit;
        if (sets == 0) revert NothingToMint();

        uint256 spend = sets * unit;
        uint256 dust = balance - spend;

        // Approve exactly what mint will pull; CalibreMarket.mint credits the
        // complete set to msg.sender (this contract), backed 1:1 by the locked USDC.
        usdc.approve(address(market), spend);
        market.mint(chainMarketId, sets);

        // Forward both legs to the end recipient.
        market.transferShares(chainMarketId, true, recipient, sets);
        market.transferShares(chainMarketId, false, recipient, sets);

        // Refund any sub-unit remainder so nothing is stranded here.
        if (dust != 0) _refund(recipient, dust);

        emit DepositMinted(chainMarketId, recipient, sets, dust);
    }

    /// @dev Push `amount` USDC to `to`, honoring both reverting and false-returning
    ///      ERC-20s (mirrors CalibreMarket's `_safeTransfer`).
    function _refund(address to, uint256 amount) internal {
        if (!usdc.transfer(to, amount)) revert UsdcTransferFailed();
    }
}
