#!/usr/bin/env python3
"""A6 / #456 — re-confirm the EIP-712 voucher digest against the DEPLOYED contract.

The offline parity test (``agent/tests/test_voucher.py``) proves the agent's
signer digest byte-matches a Python *reproduction* of ``CalibreMarket.hashQuote``.
That guards the source, but the live deploy adds two operator-supplied values the
offline test can't see: the **deployed contract address** (``verifyingContract``)
and the **chainId** the domain separator was baked with. A typo in either silently
breaks every on-chain ``buy`` with ``BadSignature``.

This script closes that gap. It computes the digest the agent's signer would sign
(off-chain, using the agent's *frozen* ``_QUOTE_TYPES`` — no re-typed copy) for the
exact ``(address, chainId)`` the signer is configured with, and compares it to the
digest read straight off the **live deployed contract** via ``hashQuote`` (which
embeds the contract's real cached domain separator). Byte-equal ⇒ the configured
address/chainId match the deployment and the voucher path is sound; a mismatch ⇒
stop, the signer is pointed at the wrong address/chain and no buy would verify.

Run it after the live deploy, once ``CALIBRE_MARKET_ADDRESS`` / ``ARC_RPC_URL`` /
``ARC_CHAIN_ID`` are filled in (see ``docs/DEPLOY-RUNBOOK.md`` step 7):

    cd agent && pip install -e .
    CALIBRE_MARKET_ADDRESS=0x... ARC_RPC_URL=https://rpc.testnet.arc.network \
    ARC_CHAIN_ID=5042002 python scripts/verify_deployed_digest.py

Exit 0 + "DIGEST MATCH" on parity; exit 1 + a diff on mismatch.
"""
from __future__ import annotations

import os
import sys

from eth_account.messages import encode_typed_data
from eth_utils import keccak

# Import the agent's FROZEN EIP-712 surface so this check uses exactly what the
# real signer signs — any drift in field order/types is inherited here, not masked.
from calibre_agent.voucher import EIP712_NAME, EIP712_VERSION, _QUOTE_TYPES

# Minimal ABI for the one view we read off the deployed contract.
_HASH_QUOTE_ABI = [
    {
        "name": "hashQuote",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {
                "name": "q",
                "type": "tuple",
                "components": [
                    {"name": "marketId", "type": "uint256"},
                    {"name": "buyer", "type": "address"},
                    {"name": "side", "type": "uint8"},
                    {"name": "size", "type": "uint256"},
                    {"name": "maxCost", "type": "uint256"},
                    {"name": "nonce", "type": "uint256"},
                    {"name": "expiry", "type": "uint256"},
                ],
            }
        ],
        "outputs": [{"name": "", "type": "bytes32"}],
    }
]


def sample_quote(buyer: str) -> dict:
    """A representative, fully-populated Quote. Field *values* don't matter for the
    digest comparison — only that both sides hash the *same* struct — but every
    field is non-trivial so a per-field encoding slip would still surface."""
    return {
        "marketId": 42,
        "buyer": buyer,
        "side": 1,
        "size": 10,
        "maxCost": 7_000_000,
        "nonce": 0,
        "expiry": 1_893_456_000,
    }


def offchain_digest(quote: dict, *, chain_id: int, verifying: str) -> bytes:
    """The EIP-712 digest the agent's signer would sign for ``quote`` against the
    given domain — computed via the agent's frozen ``_QUOTE_TYPES`` (the real path).
    """
    domain = {
        "name": EIP712_NAME,
        "version": EIP712_VERSION,
        "chainId": chain_id,
        "verifyingContract": verifying,
    }
    signable = encode_typed_data(
        domain_data=domain, message_types=_QUOTE_TYPES, message_data=quote
    )
    # Reconstruct the 0x19-framed digest eth_account hashes (matches the offline
    # parity test in test_voucher.py).
    return keccak(b"\x19" + signable.version + signable.header + signable.body)


def onchain_digest(quote: dict, *, rpc_url: str, address: str) -> bytes:
    """``CalibreMarket.hashQuote(quote)`` read off the live deployed contract — its
    answer embeds the contract's real cached domain separator (address + chainId).
    """
    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(rpc_url))
    if not w3.is_connected():
        raise SystemExit(f"could not connect to RPC at {rpc_url}")
    market = w3.eth.contract(
        address=Web3.to_checksum_address(address), abi=_HASH_QUOTE_ABI
    )
    q = (
        quote["marketId"],
        Web3.to_checksum_address(quote["buyer"]),
        quote["side"],
        quote["size"],
        quote["maxCost"],
        quote["nonce"],
        quote["expiry"],
    )
    return bytes(market.functions.hashQuote(q).call())


def _require_env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise SystemExit(
            f"missing required env var {name} — see docs/DEPLOY-RUNBOOK.md step 7"
        )
    return v


def main() -> int:
    address = _require_env("CALIBRE_MARKET_ADDRESS")
    rpc_url = _require_env("ARC_RPC_URL")
    chain_id = int(_require_env("ARC_CHAIN_ID"))

    # A throwaway but valid buyer address; the digest doesn't depend on it being
    # funded — it just has to be the same on both sides.
    buyer = "0x000000000000000000000000000000000000dEaD"
    quote = sample_quote(buyer)

    off = offchain_digest(quote, chain_id=chain_id, verifying=address)
    on = onchain_digest(quote, rpc_url=rpc_url, address=address)

    print(f"contract        : {address}")
    print(f"chainId         : {chain_id}")
    print(f"off-chain digest: 0x{off.hex()}")
    print(f"on-chain  digest: 0x{on.hex()}")

    if off == on:
        print("\nDIGEST MATCH — signer is byte-equal with the deployed contract.")
        return 0
    print(
        "\nDIGEST MISMATCH — the agent/signer is NOT byte-equal with the deployed "
        "contract.\nEvery on-chain buy would revert with BadSignature. Check that "
        "CALIBRE_MARKET_ADDRESS\nand ARC_CHAIN_ID match the actual deployment "
        "before flipping the live flags."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
