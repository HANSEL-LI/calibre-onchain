// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IERC20
/// @notice Minimal ERC-20 surface CalibreMarket needs. Vendored locally so the
///         contracts package keeps its only dependency as forge-std (parsimony).
/// @dev    On Arc the USDC asset is dual-view: the native gas token is 18-decimal
///         but THIS ERC-20 interface is 6-decimal (W8 spike §3). CalibreMarket
///         performs all USDC accounting through this interface and reads
///         `decimals()` once at construction, so it is correct for the 6-dec
///         token without conflating it with the 18-dec native asset.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function approve(address spender, uint256 amount) external returns (bool);

    function balanceOf(address account) external view returns (uint256);

    function decimals() external view returns (uint8);
}
