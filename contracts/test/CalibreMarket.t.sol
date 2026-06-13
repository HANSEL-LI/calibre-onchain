// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CalibreMarket} from "../src/CalibreMarket.sol";

/// @dev W0 SCAFFOLD — smoke test only. Proves the toolchain + forge-std
///      remapping resolve and the project compiles + tests run. Real
///      mint/trade/resolve/redeem coverage lands with the W1.1 implementation.
contract CalibreMarketTest is Test {
    CalibreMarket internal market;

    function setUp() public {
        market = new CalibreMarket();
    }

    function test_Version() public view {
        assertEq(market.VERSION(), "0.0.0-scaffold");
    }
}
