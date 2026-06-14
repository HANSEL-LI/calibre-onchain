// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CalibreMarket} from "../src/CalibreMarket.sol";
import {DepositAndMintHook} from "../src/DepositAndMintHook.sol";

/// @notice Deploys the CCTP V2 bridge-and-mint hook (#613) against an already
///         deployed CalibreMarket on Arc testnet (chainId 5042002).
/// @dev    Arc is **CCTP V2 domain 26** (standard Transfer + Forwarding; Fast
///         Transfer is N/A — standard attestation is already fast, so there is no
///         Fast-Transfer liquidity dependency). To bridge-and-mint, a source-chain
///         caller uses `depositForBurnWithHook` with:
///           - destinationDomain = ARC_CCTP_DOMAIN (26),
///           - mintRecipient     = this hook's address (bytes32),
///           - hookData          = abi.encodePacked(
///                 hookAddress,
///                 abi.encodeCall(DepositAndMintHook.depositAndMint,
///                                (chainMarketId, recipient))).
///         A relayer then runs Circle's CCTPHookWrapper.relay(message, attestation)
///         on Arc, which mints the USDC to the hook and invokes depositAndMint.
///
///         Reads one env var:
///           - `MARKET_ADDRESS`: the deployed CalibreMarket (from Deploy.s.sol).
///
///         Run:
///           forge script script/DeployHook.s.sol:DeployHook \
///             --rpc-url https://rpc.testnet.arc.network --broadcast
contract DeployHook is Script {
    /// @notice Arc's CCTP V2 domain id. Documented here for the off-chain
    ///         bridge/relayer wiring; the hook itself is domain-agnostic.
    uint32 public constant ARC_CCTP_DOMAIN = 26;

    function run() external returns (DepositAndMintHook hook) {
        address market = vm.envAddress("MARKET_ADDRESS");

        vm.startBroadcast();
        hook = new DepositAndMintHook(CalibreMarket(market));
        vm.stopBroadcast();

        console2.log("DepositAndMintHook deployed:", address(hook));
        console2.log("  market:", market);
        console2.log("  usdc:", address(hook.usdc()));
        console2.log("  arcCctpDomain:", ARC_CCTP_DOMAIN);
    }
}
