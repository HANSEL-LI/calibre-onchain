"""MarketClient — the agent's on-chain leg against the Arc ``CalibreMarket``.

The merged contract is **W1.1** (``contracts/src/CalibreMarket.sol``): the
custody-independent core. Its EIP-712 voucher buy/redeem path is **W1.2 (#422),
not yet merged**, so the trade surface a non-resolver agent can drive today is:

- ``mint(chainMarketId, sets)`` — pull ``sets * usdcUnit`` USDC (ERC-20,
  6-decimal), credit ``sets`` YES + ``sets`` NO (a complete set).
- ``transferShares(chainMarketId, isYes, to, amount)`` — move one side.
- ``redeem(chainMarketId)`` — after resolve, redeem the winning side 1:1.
- views: ``markets(id)`` (exists, outcome), ``yesBalance``/``noBalance``.

The merged ``sdk`` only encodes ``createMarket``/``resolve`` (the resolver seam),
so the agent carries its own minimal ABI for these caller-facing primitives plus
the ERC-20 USDC slice it needs to approve spending. When W1.2 lands, ``mint`` is
swapped for a voucher-buy with no change to the loop (see the README).

USDC decimals (W8 spike §3): Arc's native USDC is 18-decimal but the **ERC-20**
interface is 6-decimal; ``usdcUnit`` is read from the contract, which reads it
from ``usdc.decimals()`` at deploy, so this client never hardcodes the scale.
"""
from __future__ import annotations

from dataclasses import dataclass

# Contract Outcome enum (CalibreMarket.sol): UNRESOLVED=0, YES=1, NO=2.
OUTCOME_UNRESOLVED = 0
OUTCOME_YES = 1
OUTCOME_NO = 2

# Minimal CalibreMarket ABI — only the caller-facing primitives + views.
_MARKET_ABI = [
    {
        "type": "function", "name": "mint", "stateMutability": "nonpayable",
        "inputs": [{"name": "chainMarketId", "type": "uint256"},
                   {"name": "sets", "type": "uint256"}],
        "outputs": [],
    },
    {
        "type": "function", "name": "transferShares", "stateMutability": "nonpayable",
        "inputs": [{"name": "chainMarketId", "type": "uint256"},
                   {"name": "isYes", "type": "bool"},
                   {"name": "to", "type": "address"},
                   {"name": "amount", "type": "uint256"}],
        "outputs": [],
    },
    {
        "type": "function", "name": "redeem", "stateMutability": "nonpayable",
        "inputs": [{"name": "chainMarketId", "type": "uint256"}],
        "outputs": [],
    },
    {
        "type": "function", "name": "markets", "stateMutability": "view",
        "inputs": [{"name": "", "type": "uint256"}],
        "outputs": [{"name": "exists", "type": "bool"},
                    {"name": "outcome", "type": "uint8"}],
    },
    {
        "type": "function", "name": "yesBalance", "stateMutability": "view",
        "inputs": [{"name": "", "type": "uint256"}, {"name": "", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function", "name": "noBalance", "stateMutability": "view",
        "inputs": [{"name": "", "type": "uint256"}, {"name": "", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function", "name": "usdcUnit", "stateMutability": "view",
        "inputs": [], "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function", "name": "usdc", "stateMutability": "view",
        "inputs": [], "outputs": [{"name": "", "type": "address"}],
    },
]

# Minimal ERC-20 slice for the USDC approve the agent needs before mint.
_ERC20_ABI = [
    {
        "type": "function", "name": "approve", "stateMutability": "nonpayable",
        "inputs": [{"name": "spender", "type": "address"},
                   {"name": "amount", "type": "uint256"}],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "type": "function", "name": "allowance", "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"},
                   {"name": "spender", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function", "name": "balanceOf", "stateMutability": "view",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
]


@dataclass(frozen=True)
class MarketView:
    """Snapshot of the agent's on-chain state for one market."""

    exists: bool
    outcome: int  # OUTCOME_* enum
    yes_shares: int
    no_shares: int

    @property
    def resolved(self) -> bool:
        return self.outcome != OUTCOME_UNRESOLVED

    @property
    def net_sets(self) -> int:
        """Net complete sets the agent holds (min of the two sides — a complete
        set is one YES + one NO; the overlap is the inventory the cap bounds)."""
        return min(self.yes_shares, self.no_shares)


class MarketClient:
    """Build / sign / broadcast ``CalibreMarket`` transactions via a Signer.

    web3 is imported at construction so importing this module is cheap. The
    Signer owns key material; this client owns the provider and tx assembly.
    """

    def __init__(self, *, rpc_url: str, chain_id: int, contract_address: str,
                 signer, usdc_address: str = "") -> None:
        from web3 import Web3

        self._signer = signer
        self._chain_id = chain_id
        self._w3 = Web3(Web3.HTTPProvider(rpc_url))
        self._market = self._w3.eth.contract(
            address=Web3.to_checksum_address(contract_address), abi=_MARKET_ABI
        )
        self._usdc_address = usdc_address
        self._usdc = (
            self._w3.eth.contract(
                address=Web3.to_checksum_address(usdc_address), abi=_ERC20_ABI
            )
            if usdc_address
            else None
        )

    @property
    def address(self) -> str:
        return self._signer.address

    def view(self, market_id: int) -> MarketView:
        """Read the agent's state for ``market_id`` (no tx)."""
        exists, outcome = self._market.functions.markets(int(market_id)).call()
        addr = self._signer.address
        yes = self._market.functions.yesBalance(int(market_id), addr).call()
        no = self._market.functions.noBalance(int(market_id), addr).call()
        return MarketView(exists=bool(exists), outcome=int(outcome),
                          yes_shares=int(yes), no_shares=int(no))

    def usdc_unit(self) -> int:
        return int(self._market.functions.usdcUnit().call())

    def _send(self, fn) -> str:
        nonce = self._w3.eth.get_transaction_count(self._signer.address)
        tx = fn.build_transaction({
            "chainId": self._chain_id,
            "from": self._signer.address,
            "nonce": nonce,
        })
        raw = self._signer.sign_transaction(tx)
        tx_hash = self._w3.eth.send_raw_transaction(raw)
        return tx_hash.hex()

    def ensure_allowance(self, sets: int) -> str | None:
        """Approve the market to pull ``sets * usdcUnit`` USDC if allowance is
        short. Returns the approve tx hash, or None if already sufficient or no
        USDC address is configured (then mint will revert if unapproved — the
        caller logs that)."""
        if self._usdc is None:
            return None
        need = sets * self.usdc_unit()
        owner = self._signer.address
        spender = self._market.address
        current = int(self._usdc.functions.allowance(owner, spender).call())
        if current >= need:
            return None
        return self._send(self._usdc.functions.approve(spender, need))

    def mint(self, market_id: int, sets: int) -> str:
        """Mint ``sets`` complete sets; returns the tx hash."""
        return self._send(self._market.functions.mint(int(market_id), int(sets)))

    def redeem(self, market_id: int) -> str:
        """Redeem the winning side after resolve; returns the tx hash."""
        return self._send(self._market.functions.redeem(int(market_id)))
