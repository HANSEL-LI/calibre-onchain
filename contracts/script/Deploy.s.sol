// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CalibreMarket} from "../src/CalibreMarket.sol";
import {IERC20} from "../src/IERC20.sol";

/// @notice Deploys CalibreMarket to Arc testnet (chainId 5042002).
/// @dev    Reads two env vars (no EIP-712 domain — that is W1.2):
///         - `USDC_ADDRESS`: the 6-decimal ERC-20 USDC token on Arc testnet.
///         - `RESOLVER_ADDRESS`: the initial resolver authority (a throwaway
///           weekend key; W1.3 hands the role to the backend signer via
///           `setResolver`). Defaults to the broadcasting account if unset.
///
///         Run:
///           forge script script/Deploy.s.sol:Deploy \
///             --rpc-url https://rpc.testnet.arc.network --broadcast
contract Deploy is Script {
    function run() external returns (CalibreMarket market) {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address resolver = vm.envOr("RESOLVER_ADDRESS", msg.sender);

        vm.startBroadcast();
        market = new CalibreMarket(IERC20(usdc), resolver);
        vm.stopBroadcast();

        console2.log("CalibreMarket deployed:", address(market));
        console2.log("  usdc:", usdc);
        console2.log("  resolver:", resolver);
    }
}
