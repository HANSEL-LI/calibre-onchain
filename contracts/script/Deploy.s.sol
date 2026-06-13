// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {CalibreMarket} from "../src/CalibreMarket.sol";

/// @dev W0 SCAFFOLD — deploy entrypoint placeholder. Broadcasts a bare
///      CalibreMarket so the deploy path exists; constructor args (USDC token,
///      resolver authority, EIP-712 domain) are wired in W1.1.
contract Deploy is Script {
    function run() external returns (CalibreMarket market) {
        vm.startBroadcast();
        market = new CalibreMarket();
        vm.stopBroadcast();
    }
}
