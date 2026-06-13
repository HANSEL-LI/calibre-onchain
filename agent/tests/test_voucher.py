"""Voucher path tests — EIP-712 digest parity + the buy leg, no network/chain.

The headline test (`test_digest_matches_contract_hashquote`) is the #443-flagged
on-chain-break guard: the digest the agent signs must byte-match
``CalibreMarket.hashQuote``. forge is not in this env, so the oracle reproduces the
contract's `hashQuote` body line-for-line in `eth_abi.encode` (same typehash
strings, same field order, same `0x1901` framing) and asserts the agent's
`eth_account.encode_typed_data` digest equals it. Any drift in field order / domain
fields fails here, offline.
"""
from __future__ import annotations

import pytest
from eth_abi import encode as abi_encode
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak

from calibre_agent.config import AgentConfig
from calibre_agent.contract import OUTCOME_NO, OUTCOME_YES, MarketClient
from calibre_agent.voucher import (
    EIP712_NAME,
    EIP712_VERSION,
    LocalVoucherSigner,
    SignedVoucher,
    _QUOTE_TYPES,
    _cost_and_maxcost,
    build_voucher_source,
)

# Solidity-faithful typehashes (verbatim from CalibreMarket.sol).
_DOMAIN_TYPEHASH = keccak(
    b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
)
_QUOTE_TYPEHASH = keccak(
    b"Quote(uint256 marketId,address buyer,uint8 side,uint256 size,"
    b"uint256 maxCost,uint256 nonce,uint256 expiry)"
)

CHAIN_ID = 5042002
VERIFYING = "0x000000000000000000000000000000000000dEaD"


def _contract_hash_quote(q: dict, *, chain_id: int, verifying: str) -> bytes:
    """Reproduce CalibreMarket.hashQuote(q) exactly in Python (the parity oracle).

    domainSeparator = keccak(abi.encode(DOMAIN_TYPEHASH, keccak(name), keccak(version),
                                        chainId, verifyingContract))
    structHash      = keccak(abi.encode(QUOTE_TYPEHASH, marketId, buyer, side, size,
                                        maxCost, nonce, expiry))
    digest          = keccak(0x1901 || domainSeparator || structHash)
    """
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


def _eth_account_digest(q: dict, *, chain_id: int, verifying: str) -> bytes:
    """The digest eth_account (and so the agent's signer) actually signs."""
    domain = {"name": EIP712_NAME, "version": EIP712_VERSION,
              "chainId": chain_id, "verifyingContract": verifying}
    signable = encode_typed_data(domain_data=domain, message_types=_QUOTE_TYPES,
                                 message_data=q)
    return keccak(b"\x19" + signable.version + signable.header + signable.body)


def _quote(**kw) -> dict:
    base = dict(marketId=42, buyer=VERIFYING, side=1, size=10,
                maxCost=7_000_000, nonce=0, expiry=1_893_456_000)
    base.update(kw)
    return base


# --- the on-chain-break guard ----------------------------------------------

def test_digest_matches_contract_hashquote():
    q = _quote(buyer=Account.create().address)
    oracle = _contract_hash_quote(q, chain_id=CHAIN_ID, verifying=VERIFYING)
    agent = _eth_account_digest(q, chain_id=CHAIN_ID, verifying=VERIFYING)
    assert agent == oracle, "agent EIP-712 digest must byte-match hashQuote"


def test_digest_parity_across_fields():
    # Vary every field; parity must hold for all (catches per-field encoding drift).
    for q in (
        _quote(side=0), _quote(marketId=1, size=1, nonce=5),
        _quote(maxCost=0, expiry=1), _quote(buyer=Account.create().address),
    ):
        assert _eth_account_digest(q, chain_id=CHAIN_ID, verifying=VERIFYING) \
            == _contract_hash_quote(q, chain_id=CHAIN_ID, verifying=VERIFYING)


# --- local signer round-trip ------------------------------------------------

def test_local_signer_recovers_to_voucher_signer():
    key = "0x" + "11" * 32
    signer = LocalVoucherSigner(signer_key=key, chain_id=CHAIN_ID,
                                verifying_contract=VERIFYING, usdc_unit=1_000_000,
                                now=lambda: 1000)
    buyer = Account.create().address
    v = signer.fetch(market_id=42, side=OUTCOME_YES, size=10, buyer=buyer,
                     nonce=0, price_yes_micro=6000)
    # The signature recovers to the configured voucherSigner over hashQuote.
    digest = _contract_hash_quote(v.quote, chain_id=CHAIN_ID, verifying=VERIFYING)
    recovered = Account._recover_hash(digest, signature=v.signature)
    assert recovered == signer.signer_address
    assert v.quote["buyer"] == buyer
    assert v.quote["nonce"] == 0
    assert v.quote["expiry"] == 1000 + 30  # now() + default expiry
    assert len(v.signature) == 65


def test_local_signer_cost_within_maxcost_and_priced_by_side():
    key = "0x" + "22" * 32
    unit = 1_000_000
    signer = LocalVoucherSigner(signer_key=key, chain_id=CHAIN_ID,
                                verifying_contract=VERIFYING, usdc_unit=unit,
                                now=lambda: 0)
    # YES at 6000 micro = 0.60 prob; 10 shares => 6 USDC. The contract charges
    # the signed maxCost (#465), so maxCost == cost — the buyer pays exactly 6.
    yes = signer.fetch(market_id=42, side=OUTCOME_YES, size=10, buyer=VERIFYING,
                       nonce=0, price_yes_micro=6000)
    assert yes.cost == 6 * unit
    assert yes.quote["maxCost"] == 6 * unit
    assert yes.cost == yes.quote["maxCost"]
    # NO side prices off (1 - prior): NO at 6000 prior = 0.40 => 4 USDC for 10.
    no = signer.fetch(market_id=42, side=OUTCOME_NO, size=10, buyer=VERIFYING,
                      nonce=0, price_yes_micro=6000)
    assert no.cost == 4 * unit


def test_cost_and_maxcost_helper():
    cost, max_cost = _cost_and_maxcost(side=1, size=10, price_yes_micro=5000,
                                       usdc_unit=1_000_000)
    assert cost == 5_000_000  # 0.50 * 10 * 1e6
    # maxCost == cost: the contract charges the signed maxCost (#465), no buffer.
    assert max_cost == cost


# --- build_voucher_source selection -----------------------------------------

def test_build_prefers_calibre_endpoint():
    cfg = AgentConfig(market_id=1, calibre_voucher_api_base="https://x/api/v1")
    src = build_voucher_source(cfg, chain_id=CHAIN_ID, verifying_contract=VERIFYING,
                               usdc_unit=1_000_000)
    assert type(src).__name__ == "CalibreVoucherClient"


def test_build_falls_back_to_local_key():
    cfg = AgentConfig(market_id=1, agent_voucher_signer_key="0x" + "33" * 32)
    src = build_voucher_source(cfg, chain_id=CHAIN_ID, verifying_contract=VERIFYING,
                               usdc_unit=1_000_000)
    assert isinstance(src, LocalVoucherSigner)


def test_build_raises_when_unconfigured():
    cfg = AgentConfig(market_id=1)
    with pytest.raises(ValueError):
        build_voucher_source(cfg, chain_id=CHAIN_ID, verifying_contract=VERIFYING,
                             usdc_unit=1_000_000)


# --- MarketClient.buy assembles the tx from the voucher ---------------------

class _FakeSigner:
    address = "0x000000000000000000000000000000000000BEEF"

    def sign_transaction(self, tx):
        return b"\x00"


class _FakeFn:
    def __init__(self, recorder, name):
        self._recorder = recorder
        self._name = name

    def __call__(self, *args):
        self._recorder.calls.append((self._name, args))
        return self

    def call(self):
        return self._recorder.returns.get(self._name, 0)

    def build_transaction(self, params):
        return {"data": "0x", **params}


class _FakeFunctions:
    def __init__(self, recorder):
        self._recorder = recorder

    def __getattr__(self, name):
        return _FakeFn(self._recorder, name)


class _FakeContract:
    def __init__(self, recorder):
        self.functions = _FakeFunctions(recorder)
        self.address = "0x00000000000000000000000000000000000000A1"


class _FakeEth:
    def get_transaction_count(self, addr):
        return 7

    def send_raw_transaction(self, raw):
        return b"\xab\xcd"


class _FakeW3:
    eth = _FakeEth()


class _Recorder:
    def __init__(self, nonce=3):
        self.calls = []
        self.returns = {"nonces": nonce}


class _FakeVoucherSource:
    def __init__(self):
        self.fetched = None

    def fetch(self, *, market_id, side, size, buyer, nonce, price_yes_micro):
        self.fetched = dict(market_id=market_id, side=side, size=size,
                            buyer=buyer, nonce=nonce, price_yes_micro=price_yes_micro)
        quote = dict(marketId=market_id, buyer=buyer, side=side, size=size,
                     maxCost=999, nonce=nonce, expiry=123)
        return SignedVoucher(quote=quote, cost=500, signature=b"\x01" * 65)


def _wire_client() -> tuple[MarketClient, _Recorder, _FakeVoucherSource]:
    """Construct a MarketClient without web3 by stubbing the assembled bits."""
    client = MarketClient.__new__(MarketClient)
    rec = _Recorder()
    client._signer = _FakeSigner()
    client._chain_id = CHAIN_ID
    client._w3 = _FakeW3()
    client._market = _FakeContract(rec)
    client._usdc = None
    src = _FakeVoucherSource()
    client._voucher_source = src
    return client, rec, src


def test_buy_reads_nonce_and_submits_voucher():
    client, rec, src = _wire_client()
    tx_hash = client.buy(42, side=OUTCOME_YES, size=10, price_yes_micro=6000)
    # The voucher source got the on-chain nonce (3) + the agent as buyer.
    assert src.fetched["nonce"] == 3
    assert src.fetched["buyer"] == _FakeSigner.address
    assert src.fetched["side"] == OUTCOME_YES
    # buy() was called with (quote_tuple, sig) — no unsigned cost arg (#465);
    # the contract charges the signed maxCost in the quote tuple.
    buy_calls = [c for c in rec.calls if c[0] == "buy"]
    assert len(buy_calls) == 1
    quote_tuple, sig = buy_calls[0][1]
    assert quote_tuple == (42, _FakeSigner.address, OUTCOME_YES, 10, 999, 3, 123)
    assert sig == b"\x01" * 65
    assert tx_hash  # a hex string from the fake tx hash


def test_buy_without_source_raises():
    client, rec, _ = _wire_client()
    client._voucher_source = None
    with pytest.raises(RuntimeError):
        client.buy(42, side=OUTCOME_YES, size=1, price_yes_micro=5000)
