// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../../src/IERC20.sol";

/// @notice A 6-decimal USDC mock whose `transfer` returns `false` WITHOUT reverting
///         (the no-bool-revert ERC-20 failure mode CalibreMarket / DepositAndMintHook
///         guard against). `transferFrom`/`approve` behave normally so the mint path
///         succeeds and only the hook's dust-`_refund` leg trips the false branch,
///         exercising the otherwise-untested `UsdcTransferFailed` revert.
contract MockFalseTransferUSDC is IERC20 {
    uint8 public constant override decimals = 6;

    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    /// @dev Always reports failure via the return value (never reverts), without
    ///      moving funds — the exact case a naive `usdc.transfer(...)` would ignore.
    function transfer(address, uint256) external pure override returns (bool) {
        return false;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "MockFalseTransferUSDC: allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        require(balanceOf[from] >= amount, "MockFalseTransferUSDC: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
