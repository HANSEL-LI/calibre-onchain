"""MarketClient — the agent's on-chain leg against the Arc ``CalibreMarket``.

The contract is ``contracts/src/CalibreMarket.sol`` — the W1.1 custody-independent
core plus the merged **W1.2 (#422)** EIP-712 voucher extension. The agent's making
leg is now the **voucher buy** (``buy(quote, sig)``, #444); the W1.1
complete-set ``mint`` is retained as a primitive but no longer the making venue.
The trade surface this client drives:

- ``buy(quote, sig)`` — submit a backend-signed EIP-712 voucher (W1.2): the
  agent (the buyer) takes ``size`` shares of one side from calibre's
  standing-counterparty inventory against the signed ``quote.maxCost`` USDC pull
  (the charge is the signed amount; #465 dropped the unsigned ``cost`` arg).
- ``redeem(chainMarketId)`` — after resolve, redeem the winning side 1:1.
- ``mint(chainMarketId, sets)`` — W1.1 complete-set mint (retained primitive).
- ``transferShares(chainMarketId, isYes, to, amount)`` — move one side.
- views: ``markets(id)`` (exists, outcome), ``yesBalance``/``noBalance``,
  ``nonces(buyer)`` (the buyer's monotonic voucher nonce).

The merged ``sdk`` only encodes ``createMarket``/``resolve`` (the resolver seam),
so the agent carries its own minimal ABI for these caller-facing primitives plus
the ERC-20 USDC slice it needs to approve spending. The voucher itself is signed
by calibre (``voucherSigner``); the agent obtains it via a
:class:`~calibre_agent.voucher.VoucherSource` and submits it under its own key.

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
        # W1.2 EIP-712 voucher buy: buy(Quote q, bytes sig). The charge is the
        # signed q.maxCost itself — there is no separate unsigned cost arg
        # (dropped in #465 so a buyer cannot pay below the signed price). The
        # tuple field order is the FROZEN Quote struct (CalibreMarket.sol).
        "type": "function", "name": "buy", "stateMutability": "nonpayable",
        "inputs": [
            {"name": "q", "type": "tuple", "components": [
                {"name": "marketId", "type": "uint256"},
                {"name": "buyer", "type": "address"},
                {"name": "side", "type": "uint8"},
                {"name": "size", "type": "uint256"},
                {"name": "maxCost", "type": "uint256"},
                {"name": "nonce", "type": "uint256"},
                {"name": "expiry", "type": "uint256"},
            ]},
            {"name": "sig", "type": "bytes"},
        ],
        "outputs": [],
    },
    {
        "type": "function", "name": "nonces", "stateMutability": "view",
        "inputs": [{"name": "", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
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
                 signer, usdc_address: str = "", voucher_source=None) -> None:
        from web3 import Web3

        self._signer = signer
        self._chain_id = chain_id
        self._voucher_source = voucher_source
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

    def set_voucher_source(self, voucher_source) -> None:
        """Attach the voucher source used by :meth:`buy`. Set post-construction
        because building a local signer needs ``usdc_unit`` (read from chain)."""
        self._voucher_source = voucher_source

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
        """Mint ``sets`` complete sets; returns the tx hash.

        Retained as a W1.1 primitive; the agent's making leg is now ``buy`` (the
        W1.2 voucher path). Kept for the redeem-side approve math + manual use.
        """
        return self._send(self._market.functions.mint(int(market_id), int(sets)))

    def nonce_of(self, buyer: str) -> int:
        """The buyer's current monotonic voucher nonce (the next valid one)."""
        return int(self._market.functions.nonces(buyer).call())

    def buy(self, market_id: int, *, side: int, size: int,
            price_yes_micro: int) -> str:
        """Buy ``size`` shares of ``side`` via a W1.2 EIP-712 voucher; returns the
        tx hash. The agent is the buyer: it reads its on-chain nonce, obtains a
        voucher signed by calibre's ``voucherSigner`` from the configured
        :class:`~calibre_agent.voucher.VoucherSource`, then submits
        ``buy(quote, sig)`` under its own tx-signing identity. The contract
        charges the signed ``quote.maxCost`` (no unsigned cost arg; #465).

        ``side`` is 0=NO / 1=YES; ``price_yes_micro`` is the public prior the
        voucher source prices/bounds the cost against. Replaces the ``mint`` leg
        (#444); the strategy + loop control flow are unchanged.
        """
        if self._voucher_source is None:
            raise RuntimeError(
                "no voucher source configured on MarketClient; cannot buy"
            )
        buyer = self._signer.address
        nonce = self.nonce_of(buyer)
        voucher = self._voucher_source.fetch(
            market_id=int(market_id), side=int(side), size=int(size),
            buyer=buyer, nonce=nonce, price_yes_micro=int(price_yes_micro),
        )
        q = voucher.quote
        # Assemble the Quote tuple in the contract's frozen field order.
        quote_tuple = (
            int(q["marketId"]), q["buyer"], int(q["side"]), int(q["size"]),
            int(q["maxCost"]), int(q["nonce"]), int(q["expiry"]),
        )
        # The contract charges the signed q.maxCost; no unsigned cost arg (#465).
        return self._send(self._market.functions.buy(
            quote_tuple, voucher.signature
        ))

    def redeem(self, market_id: int) -> str:
        """Redeem the winning side after resolve; returns the tx hash."""
        return self._send(self._market.functions.redeem(int(market_id)))
