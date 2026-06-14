// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../../src/IERC20.sol";

/// @notice Minimal 6-decimal ERC-20 mirroring the Arc USDC ERC-20 interface for
///         tests. Six decimals is deliberate: it is the interface CalibreMarket
///         must respect (W8 spike §3), so tests exercise the real unit math.
contract MockUSDC is IERC20 {
    uint8 public constant override decimals = 6;
    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";

    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "MockUSDC: allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "MockUSDC: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
