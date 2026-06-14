// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUSDC} from "./MockUSDC.sol";

/// @notice Test stand-in for Circle's CCTP V2 `CCTPHookWrapper`
///         (`src/examples/CCTPHookWrapper.sol`). `relay` reproduces the two steps
///         a real wrapper performs after attestation:
///           1. mint USDC to the burn's `mintRecipient` — here the hook contract
///              (simulating `messageTransmitter.receiveMessage`);
///           2. parse `hookData` as `target(20B) ++ hookCallData(dynamic)` and do
///              `target.call(hookCallData)` (simulating `_executeHook`).
///         Driving the *real* DepositAndMintHook through this proves the on-chain
///         integration without a live CCTP deployment.
contract MockHookRelay {
    MockUSDC public immutable usdc;

    constructor(MockUSDC usdc_) {
        usdc = usdc_;
    }

    /// @param amount   USDC amount the burn minted to `mintRecipient`.
    /// @param hookData Circle's hook payload: `abi.encodePacked(target, hookCallData)`.
    /// @dev    The real `CCTPHookWrapper.relay` returns a 3-tuple
    ///         `(bool relaySuccess, bool hookSuccess, bytes hookReturnData)`; this
    ///         mock collapses `relaySuccess` (always true post-attestation here)
    ///         and surfaces only `(hookSuccess, hookReturnData)`, which is all the
    ///         tests consume. Don't model the real return shape off this mock.
    function relay(uint256 amount, bytes calldata hookData)
        external
        returns (bool hookSuccess, bytes memory hookReturnData)
    {
        // Step 1: mint the bridged USDC to the mintRecipient (the hook `target`).
        address target = address(bytes20(hookData[0:20]));
        usdc.mint(target, amount);

        // Step 2: execute the hook exactly as CCTPHookWrapper does — a low-level
        // call to the target with the trailing hookCallData. Non-atomic with the
        // "mint" above, matching CCTP V2 semantics.
        bytes calldata hookCallData = hookData[20:];
        (hookSuccess, hookReturnData) = target.call(hookCallData);
    }
}
