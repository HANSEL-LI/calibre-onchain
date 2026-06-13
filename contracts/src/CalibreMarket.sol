// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CalibreMarket
/// @notice On-chain mirror of a calibre prediction market, settling in USDC on
///         Arc under the A-lite custody model: the LMSR engine stays off-chain;
///         this contract handles complete-set mint / trade-transfer / resolve /
///         redeem only. calibre is the standing EIP-712 counterparty.
/// @dev    W0 SCAFFOLD — placeholder only. The contract carries no market logic
///         yet; the full implementation (mint/trade/resolve/redeem, EIP-712
///         vouchers, the resolver authority) lands in W1.1. The public boundary
///         contract holds: this contract sees `(chainMarketId, outcome)` only —
///         never LMSR state, points, or ledger internals.
contract CalibreMarket {
    /// @notice Outcome of a resolved market. UNRESOLVED until the resolver settles.
    enum Outcome {
        UNRESOLVED,
        YES,
        NO
    }

    /// @notice Placeholder so `forge build` compiles a non-empty project.
    ///         Replaced by the real version/storage layout in W1.1.
    string public constant VERSION = "0.0.0-scaffold";
}
