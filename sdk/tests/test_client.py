"""Unit tests for the OnchainClient SDK — the private↔public seam.

No network, no chain. web3/eth-account are real imports, but `OnchainClient`
is built via `__new__` with fakes injected for the signer / contract `functions`
recorder / `w3.eth`, so each call's `(method, args)` and tx assembly is asserted
offline (mirrors `agent/tests/test_voucher.py`'s approach). The pure helpers
(`_outcome_to_enum`, the ABI, config) are exercised directly.

The headline boundary test (`test_*_boundary`) is the issue #468 ask: the SDK's
only settlement inputs are `(chain_market_id, outcome)` — no LMSR / points /
ledger surface crosses the public/private boundary.
"""
from __future__ import annotations

import pytest

import calibre_onchain
from calibre_onchain import OnchainClient, OnchainConfig
from calibre_onchain.client import (
    _ABI,
    _OUTCOME_NO,
    _OUTCOME_YES,
    _outcome_to_enum,
)

CHAIN_ID = 5042002
CONTRACT = "0x00000000000000000000000000000000000000A1"
SIGNER_ADDR = "0x000000000000000000000000000000000000bEEF"


# --- package surface --------------------------------------------------------

def test_public_exports_are_exactly_client_config_version():
    assert set(calibre_onchain.__all__) == {
        "OnchainClient",
        "OnchainConfig",
        "__version__",
    }
    assert calibre_onchain.__version__ == "0.1.0"


def test_config_is_frozen_dataclass():
    cfg = OnchainConfig(
        rpc_url="https://rpc.example",
        contract_address=CONTRACT,
        resolver_key="0x" + "11" * 32,
        chain_id=CHAIN_ID,
    )
    assert cfg.chain_id == CHAIN_ID
    with pytest.raises(Exception):
        cfg.chain_id = 1  # frozen=True


# --- outcome enum mapping ---------------------------------------------------

def test_outcome_yes_maps_to_enum_1():
    assert _outcome_to_enum("yes") == _OUTCOME_YES == 1


def test_outcome_no_maps_to_enum_2():
    assert _outcome_to_enum("no") == _OUTCOME_NO == 2


@pytest.mark.parametrize("raw", ["YES", " Yes ", "nO", "NO  "])
def test_outcome_mapping_is_case_and_whitespace_insensitive(raw):
    assert _outcome_to_enum(raw) in (_OUTCOME_YES, _OUTCOME_NO)


@pytest.mark.parametrize("bad", ["unresolved", "", "maybe", "1", "true"])
def test_outcome_rejects_non_yes_no(bad):
    # UNRESOLVED=0 and anything else is rejected before it can reach the
    # contract's InvalidOutcome() revert.
    with pytest.raises(ValueError):
        _outcome_to_enum(bad)


# --- ABI shape (matches CalibreMarket.sol create/seed/resolve only) ---------

def test_abi_exposes_only_create_market_seed_and_resolve():
    names = {fn["name"] for fn in _ABI}
    assert names == {"createMarket", "seedInventory", "resolve"}


def test_create_market_abi_takes_a_single_uint256():
    fn = next(f for f in _ABI if f["name"] == "createMarket")
    assert [i["type"] for i in fn["inputs"]] == ["uint256"]
    assert fn["outputs"] == []
    assert fn["stateMutability"] == "nonpayable"


def test_seed_inventory_abi_takes_two_uint256():
    fn = next(f for f in _ABI if f["name"] == "seedInventory")
    assert [i["type"] for i in fn["inputs"]] == ["uint256", "uint256"]
    assert fn["outputs"] == []
    assert fn["stateMutability"] == "nonpayable"


def test_resolve_abi_takes_uint256_chain_id_and_uint8_outcome():
    fn = next(f for f in _ABI if f["name"] == "resolve")
    assert [i["type"] for i in fn["inputs"]] == ["uint256", "uint8"]
    assert fn["outputs"] == []
    assert fn["stateMutability"] == "nonpayable"


# --- offline client fakes (mirror agent/tests/test_voucher.py) --------------

class _Recorder:
    def __init__(self):
        self.calls: list[tuple[str, tuple]] = []
        self.built: list[dict] = []
        self.signed: list[dict] = []
        self.nonce_blocks: list = []


class _FakeFn:
    def __init__(self, recorder, name):
        self._recorder = recorder
        self._name = name

    def __call__(self, *args):
        self._recorder.calls.append((self._name, args))
        return self

    def build_transaction(self, params):
        self._recorder.built.append(params)
        return {"data": "0xdeadbeef", **params}


class _FakeFunctions:
    def __init__(self, recorder):
        self._recorder = recorder

    def __getattr__(self, name):
        return _FakeFn(self._recorder, name)


class _FakeContract:
    def __init__(self, recorder):
        self.functions = _FakeFunctions(recorder)
        self.address = CONTRACT


class _SignedTx:
    raw_transaction = b"\x02\xf8raw"


class _FakeSigner:
    address = SIGNER_ADDR

    def __init__(self, recorder):
        self._recorder = recorder

    def sign_transaction(self, tx):
        self._recorder.signed.append(tx)
        return _SignedTx()


class _FakeEth:
    def __init__(self, recorder, nonce=7):
        self._recorder = recorder
        self._nonce = nonce

    def get_transaction_count(self, addr, block=None):
        # Record the block tag so the test can assert the PENDING nonce is used
        # (so back-to-back sends in one pass don't collide on the same nonce).
        self._recorder.nonce_blocks.append(block)
        return self._nonce

    def send_raw_transaction(self, raw):
        assert raw == _SignedTx.raw_transaction
        return b"\xab\xcd\xef"


class _FakeW3:
    def __init__(self, recorder, nonce=7):
        self.eth = _FakeEth(recorder, nonce=nonce)


def _wire_client(nonce=7) -> tuple[OnchainClient, _Recorder]:
    """Build an OnchainClient without web3 by injecting fakes for the assembled
    bits — no RPC, no real key derivation."""
    rec = _Recorder()
    client = OnchainClient.__new__(OnchainClient)
    client._config = OnchainConfig(
        rpc_url="https://rpc.example",
        contract_address=CONTRACT,
        resolver_key="0x" + "11" * 32,
        chain_id=CHAIN_ID,
    )
    client._w3 = _FakeW3(rec, nonce=nonce)
    client._account = _FakeSigner(rec)
    client._contract = _FakeContract(rec)
    return client, rec


# --- resolver_address -------------------------------------------------------

def test_resolver_address_is_the_signing_account():
    client, _ = _wire_client()
    assert client.resolver_address == SIGNER_ADDR


# --- create_market call-shape + tx assembly ---------------------------------

def test_create_market_encodes_create_market_with_int_id():
    client, rec = _wire_client(nonce=7)
    tx_hash = client.create_market(42)

    create_calls = [c for c in rec.calls if c[0] == "createMarket"]
    assert create_calls == [("createMarket", (42,))]
    # arg is coerced to a plain int (createMarket(uint256)).
    assert isinstance(create_calls[0][1][0], int)
    # no other contract function was touched.
    assert {c[0] for c in rec.calls} == {"createMarket"}

    built = rec.built[0]
    assert built["chainId"] == CHAIN_ID
    assert built["from"] == SIGNER_ADDR
    assert built["nonce"] == 7  # read from the on-chain transaction count

    assert tx_hash == b"\xab\xcd\xef".hex()


def test_create_market_coerces_string_id_to_int():
    client, rec = _wire_client()
    client.create_market("99")  # type: ignore[arg-type]
    assert rec.calls[0] == ("createMarket", (99,))


# --- seed_inventory call-shape + tx assembly --------------------------------

def test_seed_inventory_encodes_seed_inventory_with_int_id_and_sets():
    client, rec = _wire_client(nonce=4)
    tx_hash = client.seed_inventory(42, 100)

    seed_calls = [c for c in rec.calls if c[0] == "seedInventory"]
    assert seed_calls == [("seedInventory", (42, 100))]
    # both args coerced to plain ints (seedInventory(uint256, uint256)).
    assert all(isinstance(a, int) for a in seed_calls[0][1])
    # no other contract function was touched.
    assert {c[0] for c in rec.calls} == {"seedInventory"}

    built = rec.built[0]
    assert built["chainId"] == CHAIN_ID
    assert built["from"] == SIGNER_ADDR
    assert built["nonce"] == 4
    assert tx_hash == b"\xab\xcd\xef".hex()


def test_seed_inventory_coerces_string_args_to_int():
    client, rec = _wire_client()
    client.seed_inventory("7", "25")  # type: ignore[arg-type]
    assert rec.calls[0] == ("seedInventory", (7, 25))


def test_send_reads_the_pending_nonce_so_back_to_back_sends_sequence():
    # createMarket then seedInventory from the same account must not collide on
    # the confirmed nonce — _send reads the "pending" tag.
    client, rec = _wire_client()
    client.create_market(1)
    client.seed_inventory(1, 50)
    assert rec.nonce_blocks == ["pending", "pending"]


# --- resolve call-shape + outcome mapping -----------------------------------

def test_resolve_yes_encodes_resolve_uint256_enum1():
    client, rec = _wire_client(nonce=3)
    tx_hash = client.resolve(7, "yes")

    resolve_calls = [c for c in rec.calls if c[0] == "resolve"]
    assert resolve_calls == [("resolve", (7, _OUTCOME_YES))]
    assert {c[0] for c in rec.calls} == {"resolve"}

    built = rec.built[0]
    assert built["nonce"] == 3
    assert built["chainId"] == CHAIN_ID
    assert tx_hash == b"\xab\xcd\xef".hex()


def test_resolve_no_encodes_enum2():
    client, rec = _wire_client()
    client.resolve(7, "NO")
    assert rec.calls[0] == ("resolve", (7, _OUTCOME_NO))


def test_resolve_rejects_invalid_outcome_before_any_tx():
    client, rec = _wire_client()
    with pytest.raises(ValueError):
        client.resolve(7, "unresolved")
    # nothing was encoded, built, or signed.
    assert rec.calls == []
    assert rec.built == []
    assert rec.signed == []


# --- the #468 boundary invariant --------------------------------------------

def test_settlement_inputs_are_only_chain_id_outcome_and_set_count_boundary():
    """The SDK's public methods carry nothing beyond a chain market id, an
    outcome string, and a bare set count.

    No LMSR state, points balance, ledger row, or price crosses the seam — that
    surface stays private (see the repo README boundary section). ``sets`` is a
    plain share-pair count (the on-chain inventory depth), not a points/ledger
    quantity, so it does not breach the boundary.
    """
    import inspect

    create_params = list(inspect.signature(OnchainClient.create_market).parameters)
    assert create_params == ["self", "chain_market_id"]

    seed_params = list(inspect.signature(OnchainClient.seed_inventory).parameters)
    assert seed_params == ["self", "chain_market_id", "sets"]

    resolve_params = list(inspect.signature(OnchainClient.resolve).parameters)
    assert resolve_params == ["self", "chain_market_id", "outcome"]


def test_resolve_outcome_is_the_points_side_string_not_an_enum():
    # The caller passes "yes"/"no"; the contract enum never leaks across the seam.
    client, rec = _wire_client()
    client.resolve(1, "yes")
    # The mapped enum is an internal detail; the public arg is a string.
    sig = inspect_resolve_outcome_annotation()
    assert sig == "str"


def inspect_resolve_outcome_annotation() -> str:
    import inspect

    ann = inspect.signature(OnchainClient.resolve).parameters["outcome"].annotation
    return ann if isinstance(ann, str) else getattr(ann, "__name__", str(ann))
