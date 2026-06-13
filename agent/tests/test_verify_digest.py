"""Offline guard for scripts/verify_deployed_digest.py.

The script's live value is comparing the agent's off-chain digest to the digest
read off the *deployed* contract — that step needs an RPC and a deployment, so it
runs at deploy time (DEPLOY-RUNBOOK step 7), not here. What we *can* pin offline
is that the script's ``offchain_digest`` reproduces ``CalibreMarket.hashQuote``
byte-for-byte (the same property test_voucher.py asserts for the signer), so the
only thing left untested at deploy time is the RPC plumbing, not the crypto.
"""
from __future__ import annotations

from eth_abi import encode as abi_encode
from eth_account import Account
from eth_utils import keccak

from calibre_agent.voucher import EIP712_NAME, EIP712_VERSION

import importlib.util
import pathlib

# Load the script as a module (it lives under scripts/, not the package).
_SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "verify_deployed_digest.py"
_spec = importlib.util.spec_from_file_location("verify_deployed_digest", _SCRIPT)
vdd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vdd)

CHAIN_ID = 5042002
VERIFYING = "0x000000000000000000000000000000000000dEaD"

_DOMAIN_TYPEHASH = keccak(
    b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
)
_QUOTE_TYPEHASH = keccak(
    b"Quote(uint256 marketId,address buyer,uint8 side,uint256 size,"
    b"uint256 maxCost,uint256 nonce,uint256 expiry)"
)


def _contract_hash_quote(q: dict, *, chain_id: int, verifying: str) -> bytes:
    """CalibreMarket.hashQuote(q) reproduced in Python (the parity oracle)."""
    domain_sep = keccak(abi_encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [_DOMAIN_TYPEHASH, keccak(EIP712_NAME.encode()),
         keccak(EIP712_VERSION.encode()), chain_id, verifying],
    ))
    struct_hash = keccak(abi_encode(
        ["bytes32", "uint256", "address", "uint8", "uint256", "uint256",
         "uint256", "uint256"],
        [_QUOTE_TYPEHASH, q["marketId"], q["buyer"], q["side"], q["size"],
         q["maxCost"], q["nonce"], q["expiry"]],
    ))
    return keccak(b"\x19\x01" + domain_sep + struct_hash)


def test_offchain_digest_matches_contract_oracle():
    q = vdd.sample_quote(Account.create().address)
    oracle = _contract_hash_quote(q, chain_id=CHAIN_ID, verifying=VERIFYING)
    got = vdd.offchain_digest(q, chain_id=CHAIN_ID, verifying=VERIFYING)
    assert got == oracle, "verify script's off-chain digest must equal hashQuote"


def test_offchain_digest_sensitive_to_address_and_chain():
    # The whole point of the deploy-time check: a wrong address or chainId yields a
    # different digest. Pin that the function is actually sensitive to both.
    q = vdd.sample_quote(VERIFYING)
    base = vdd.offchain_digest(q, chain_id=CHAIN_ID, verifying=VERIFYING)
    other_addr = vdd.offchain_digest(
        q, chain_id=CHAIN_ID, verifying="0x000000000000000000000000000000000000BEEF")
    other_chain = vdd.offchain_digest(q, chain_id=CHAIN_ID + 1, verifying=VERIFYING)
    assert base != other_addr
    assert base != other_chain
