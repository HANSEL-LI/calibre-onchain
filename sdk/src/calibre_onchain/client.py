"""OnchainClient — the contract client the private calibre app imports.

Seam 1 of the ETHGlobal NYC 2026 build (calibre issue #425): the private app
mirrors a points-market resolution onto the Arc ``CalibreMarket`` contract. The
client's settlement inputs are ``(chain_market_id, outcome)`` and nothing more —
no LMSR state, points, or ledger internals cross the public/private boundary.

Two methods, both signed with the resolver key (``onlyResolver`` on the
contract):

- ``create_market(chain_market_id)`` → ``createMarket(uint256)``
- ``resolve(chain_market_id, outcome)`` → ``resolve(uint256, uint8)``

``outcome`` is the points-side string ``"yes"`` / ``"no"``; it maps to the
contract's ``Outcome`` enum **YES = 1, NO = 2** (``UNRESOLVED = 0`` is rejected
by the contract with ``InvalidOutcome()`` — see ``CalibreMarket.sol``). The
caller never sees the enum.

ABI surface: only ``createMarket`` and ``resolve`` are encoded here (this seam
is create/resolve only — mint/redeem/trading are user- or out-of-scope paths).
The fragments match ``CalibreMarket.sol`` as of W1.1; when the deployed ABI is
finalized, only ``_ABI`` + the configured address change.
"""
from __future__ import annotations

from dataclasses import dataclass

# Contract ``Outcome`` enum (CalibreMarket.sol): UNRESOLVED=0, YES=1, NO=2.
_OUTCOME_YES = 1
_OUTCOME_NO = 2

# Minimal ABI — only the two onlyResolver entrypoints this seam drives.
_ABI = [
    {
        "type": "function",
        "name": "createMarket",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "chainMarketId", "type": "uint256"}],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "resolve",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "chainMarketId", "type": "uint256"},
            {"name": "outcome", "type": "uint8"},
        ],
        "outputs": [],
    },
]


def _outcome_to_enum(outcome: str) -> int:
    """Map the points-side ``"yes"`` / ``"no"`` string to the contract enum."""
    o = outcome.strip().lower()
    if o == "yes":
        return _OUTCOME_YES
    if o == "no":
        return _OUTCOME_NO
    raise ValueError(f"outcome must be 'yes' or 'no' (got {outcome!r})")


@dataclass(frozen=True)
class OnchainConfig:
    """Connection + signing config. The private app builds this from its
    ``Settings`` (RPC URL, contract address, resolver key, chain id)."""

    rpc_url: str
    contract_address: str
    resolver_key: str
    chain_id: int


class OnchainClient:
    """Thin signer over the ``CalibreMarket`` contract.

    Constructed lazily by the app's bridge only when the on-chain mirror is
    enabled, so importing this module never forces a web3 import on the app's
    flag-off path (the app gates the import, not this module). web3/eth-account
    are imported at ``__init__`` time.

    Each call builds, signs, and broadcasts a transaction with the resolver key
    and returns the ``0x`` transaction hash as a string. Network/contract errors
    propagate to the caller — the app's bridge is the never-raise boundary, not
    the SDK.
    """

    def __init__(self, config: OnchainConfig) -> None:
        from eth_account import Account
        from web3 import Web3

        self._config = config
        self._w3 = Web3(Web3.HTTPProvider(config.rpc_url))
        self._account = Account.from_key(config.resolver_key)
        self._contract = self._w3.eth.contract(
            address=Web3.to_checksum_address(config.contract_address),
            abi=_ABI,
        )

    @property
    def resolver_address(self) -> str:
        """The resolver EOA derived from the configured key."""
        return self._account.address

    def _send(self, fn) -> str:
        nonce = self._w3.eth.get_transaction_count(self._account.address)
        tx = fn.build_transaction(
            {
                "chainId": self._config.chain_id,
                "from": self._account.address,
                "nonce": nonce,
            }
        )
        signed = self._account.sign_transaction(tx)
        tx_hash = self._w3.eth.send_raw_transaction(signed.raw_transaction)
        return tx_hash.hex()

    def create_market(self, chain_market_id: int) -> str:
        """Call ``createMarket(chainMarketId)``; return the tx hash."""
        return self._send(self._contract.functions.createMarket(int(chain_market_id)))

    def resolve(self, chain_market_id: int, outcome: str) -> str:
        """Call ``resolve(chainMarketId, outcome)``; return the tx hash.

        ``outcome`` is ``"yes"`` / ``"no"`` (mapped to the contract enum)."""
        return self._send(
            self._contract.functions.resolve(
                int(chain_market_id), _outcome_to_enum(outcome)
            )
        )
