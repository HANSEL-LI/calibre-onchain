"""VoucherSource — how the agent obtains a W1.2 EIP-712 price voucher to buy.

Under custody Model A-lite the agent does **not** mint complete sets; it buys
shares from calibre's standing-counterparty inventory by submitting a
**backend-signed** EIP-712 voucher to ``CalibreMarket.buy(quote, sig)``. The
contract charges the signed ``quote.maxCost`` (the signer sets it to the exact
intended price; #465 dropped the unsigned ``cost`` arg that let a buyer underpay).
The agent is the **buyer** (``msg.sender == quote.buyer``); the voucher is signed
by calibre's ``voucherSigner`` key — a *different* trust surface from the agent's
own tx-signing identity (its Dynamic server wallet / local key).

So the agent must *obtain* a signed voucher before it can buy. Two
implementations behind one tiny protocol, mirroring the :mod:`signer` split:

- :class:`CalibreVoucherClient` — the **production** path. POSTs the buy intent
  (market, side, size, buyer) to calibre's quote endpoint (W3.1, in the private
  app), which prices it off the live LMSR and returns a signed voucher. The exact
  endpoint + field names are isolated to this class (the W3.1 endpoint is
  owner/booth-gated; the request shape is documented from the W1.2 interface), so
  nothing booth-confirmed-only leaks into the loop. Selected when
  ``CALIBRE_VOUCHER_API_BASE`` is set.
- :class:`LocalVoucherSigner` — an offline/testnet fallback that signs the quote
  locally with a configured ``voucherSigner`` key via ``eth_account``'s EIP-712
  encoder, against the contract's frozen domain + ``Quote`` struct. Lets the
  artifact run + be tested with no calibre backend (the same role
  :class:`~calibre_agent.signer.LocalKeySigner` plays for tx signing). Selected
  when only ``AGENT_VOUCHER_SIGNER_KEY`` is set.

EIP-712 surface (frozen, must byte-match ``CalibreMarket.hashQuote`` —
``contracts/src/CalibreMarket.sol``):

- Domain: ``name="CalibreMarket"``, ``version="1"``, ``chainId`` (the chain the
  contract is deployed on), ``verifyingContract`` = the deployed market address.
- ``Quote(uint256 marketId,address buyer,uint8 side,uint256 size,uint256 maxCost,uint256 nonce,uint256 expiry)``
  — ``side`` 0=NO, 1=YES; ``maxCost`` in 6-decimal ERC-20 USDC base units.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

# Frozen EIP-712 fields — must match CalibreMarket.sol byte-for-byte.
EIP712_NAME = "CalibreMarket"
EIP712_VERSION = "1"

# Field order is the FROZEN W1.2<->W3.1 interface (CalibreMarket._QUOTE_TYPEHASH).
_QUOTE_TYPES = {
    "Quote": [
        {"name": "marketId", "type": "uint256"},
        {"name": "buyer", "type": "address"},
        {"name": "side", "type": "uint8"},
        {"name": "size", "type": "uint256"},
        {"name": "maxCost", "type": "uint256"},
        {"name": "nonce", "type": "uint256"},
        {"name": "expiry", "type": "uint256"},
    ]
}

# Signer-side discipline (W8 §5): voucher lives <=30s. The contract charges the
# signed maxCost (#465 dropped the unsigned cost arg), so the offline signer sets
# maxCost == cost — the buyer pays exactly the fair price, no slippage buffer (the
# buffer only existed to allow a lower on-chain cost, which no longer exists).
DEFAULT_EXPIRY_S = 30


@dataclass(frozen=True)
class SignedVoucher:
    """A backend-signed EIP-712 voucher ready for ``CalibreMarket.buy``.

    ``quote`` is the EIP-712 message dict (the exact field names/types the
    contract hashes); ``signature`` is the 65-byte (r,s,v) ECDSA signature over
    ``hashQuote(quote)`` by ``voucherSigner``. ``cost`` is the USDC (6-dec base
    units) the buyer will be charged — kept for the agent's own
    bookkeeping/logging, but it is **not** sent on-chain: the contract charges
    the signed ``quote['maxCost']`` (#465), so the signer sets ``maxCost`` to the
    intended charge and ``cost == quote['maxCost']``.
    """

    quote: dict
    cost: int
    signature: bytes


class VoucherSource(Protocol):
    """Anything that can hand the agent a signed voucher for a buy intent."""

    def fetch(self, *, market_id: int, side: int, size: int, buyer: str,
              nonce: int, price_yes_micro: int) -> SignedVoucher:
        """Return a :class:`SignedVoucher` for buying ``size`` of ``side`` on
        ``market_id`` as ``buyer`` at on-chain ``nonce``. ``price_yes_micro`` is
        the public prior (micro-cents) the cost is derived from."""
        ...


def _quote_dict(*, market_id: int, buyer: str, side: int, size: int,
                max_cost: int, nonce: int, expiry: int) -> dict:
    """Build the EIP-712 ``Quote`` message dict in the frozen field order."""
    return {
        "marketId": int(market_id),
        "buyer": buyer,
        "side": int(side),
        "size": int(size),
        "maxCost": int(max_cost),
        "nonce": int(nonce),
        "expiry": int(expiry),
    }


def _cost_and_maxcost(*, side: int, size: int, price_yes_micro: int,
                      usdc_unit: int) -> tuple[int, int]:
    """Derive (cost, maxCost) in 6-dec USDC base units from the public prior.

    The per-share price of the bought side is the prior for YES, ``1 - prior``
    for NO (micro-cents, ``10000`` == prob 1.0). ``cost`` is that price x size;
    ``maxCost`` equals ``cost`` — the contract charges the signed ``maxCost``
    directly (#465), so the buyer pays exactly the fair price with no slippage
    buffer. Offline-only heuristic: the production
    :class:`CalibreVoucherClient` gets the authoritative price + cost from
    calibre's LMSR, not this approximation.
    """
    side_price_micro = price_yes_micro if side == 1 else (10_000 - price_yes_micro)
    # micro-cents -> USDC base units: (price/10000) * usdc_unit per share.
    cost = side_price_micro * size * usdc_unit // 10_000
    max_cost = cost  # the signed maxCost is the charge (#465); no buffer
    return cost, max_cost


class LocalVoucherSigner:
    """Sign a voucher locally with a ``voucherSigner`` key (offline/testnet).

    The same primitive the merged ``sdk`` uses for EIP-712. Computes cost/maxCost
    from the public prior so the artifact buys end-to-end with no calibre backend.
    """

    def __init__(self, *, signer_key: str, chain_id: int, verifying_contract: str,
                 usdc_unit: int, expiry_s: int = DEFAULT_EXPIRY_S,
                 now=None) -> None:
        from eth_account import Account

        self._account = Account.from_key(signer_key)
        self._chain_id = int(chain_id)
        self._verifying_contract = verifying_contract
        self._usdc_unit = int(usdc_unit)
        self._expiry_s = int(expiry_s)
        if now is None:
            import time as _time
            now = _time.time
        self._now = now

    @property
    def signer_address(self) -> str:
        return self._account.address

    def _domain(self) -> dict:
        return {
            "name": EIP712_NAME,
            "version": EIP712_VERSION,
            "chainId": self._chain_id,
            "verifyingContract": self._verifying_contract,
        }

    def fetch(self, *, market_id: int, side: int, size: int, buyer: str,
              nonce: int, price_yes_micro: int) -> SignedVoucher:
        from eth_account import Account
        from eth_account.messages import encode_typed_data

        cost, max_cost = _cost_and_maxcost(
            side=side, size=size, price_yes_micro=price_yes_micro,
            usdc_unit=self._usdc_unit,
        )
        expiry = int(self._now()) + self._expiry_s
        quote = _quote_dict(market_id=market_id, buyer=buyer, side=side, size=size,
                            max_cost=max_cost, nonce=nonce, expiry=expiry)
        signable = encode_typed_data(
            domain_data=self._domain(), message_types=_QUOTE_TYPES, message_data=quote,
        )
        signed = Account.sign_message(signable, self._account.key)
        return SignedVoucher(quote=quote, cost=cost, signature=bytes(signed.signature))


class CalibreVoucherClient:
    """Fetch a backend-signed voucher from calibre's quote endpoint (W3.1).

    Production path. Calibre prices the buy off its live LMSR and signs the
    voucher with its ``voucherSigner`` key; the agent only submits it. The exact
    endpoint + field names are isolated to this class (the W3.1 endpoint is
    owner/booth-gated; the request/response shape is documented from the W1.2
    interface), so nothing booth-confirmed-only leaks into the loop. Both sources
    return the identical artifact (a :class:`SignedVoucher`), so swapping sources
    never touches the contract client or the loop.
    """

    def __init__(self, *, api_base: str, api_key: str = "", client=None,
                 timeout: float = 10.0) -> None:
        import httpx

        self._api_base = api_base.rstrip("/")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._client = client or httpx.Client(timeout=timeout, headers=headers)

    def fetch(self, *, market_id: int, side: int, size: int, buyer: str,
              nonce: int, price_yes_micro: int) -> SignedVoucher:
        url = f"{self._api_base}/markets/{market_id}/voucher"
        resp = self._client.post(url, json={
            "side": int(side),
            "size": int(size),
            "buyer": buyer,
            "nonce": int(nonce),
        })
        resp.raise_for_status()
        body = resp.json()
        quote = body["quote"]
        sig_hex = body["signature"]
        sig = bytes.fromhex(sig_hex[2:] if sig_hex.startswith("0x") else sig_hex)
        return SignedVoucher(quote=quote, cost=int(body["cost"]), signature=sig)


def build_voucher_source(config, *, chain_id: int, verifying_contract: str,
                         usdc_unit: int) -> VoucherSource:
    """Pick the voucher source from config: calibre's signing endpoint if its
    base URL is set (the production path), else the local-key fallback. Raises if
    neither is configured (parallels :func:`~calibre_agent.signer.build_signer`).
    """
    if config.calibre_voucher_api_base:
        return CalibreVoucherClient(
            api_base=config.calibre_voucher_api_base,
            api_key=config.calibre_voucher_api_key,
        )
    if config.agent_voucher_signer_key:
        return LocalVoucherSigner(
            signer_key=config.agent_voucher_signer_key,
            chain_id=chain_id,
            verifying_contract=verifying_contract,
            usdc_unit=usdc_unit,
        )
    raise ValueError(
        "no voucher source configured: set CALIBRE_VOUCHER_API_BASE (calibre "
        "signing endpoint) or AGENT_VOUCHER_SIGNER_KEY (local testnet fallback)"
    )
