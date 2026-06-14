"""Signer tests — Dynamic MPC server wallet + local fallback + selection.

The Dynamic path is exercised against a **faithful fake** of the documented
``dynamic-wallet-sdk`` contract (mirroring the calibre repo's
``app/components/wallet-connect.test.js`` approach): an async context-manager
client whose methods match the real SDK verbatim —

    DynamicEvmWalletClient(env_id)            # ctor takes the environment id
      .authenticate_api_token(token)          # async
      .create_wallet_account(threshold_signature_scheme=, password=) -> props
            props.account_address / props.wallet_id   # WalletProperties
      .send_transaction(address=, tx=, password=, rpc_url=) -> tx_hash  # signs+broadcasts

No network, no real Dynamic account. We assert the contract usage, that the
sensitive material is never logged/repr'd, that only non-sensitive metadata is
persisted, and that signer selection gates correctly.
"""
from __future__ import annotations

import enum
from dataclasses import dataclass

import pytest

from calibre_agent.config import AgentConfig
from calibre_agent.signer import (
    DynamicServerWallet,
    LocalKeySigner,
    SecretRef,
    _default_scheme_resolver,
    _legacy_tx,
    build_signer,
)


# ---- faithful fake of the dynamic-wallet-sdk client ------------------------
class FakeThresholdSignatureScheme(enum.Enum):
    """Mirrors the real SDK's ``ThresholdSignatureScheme`` enum (the SDK supports
    exactly these two members — no THREE_OF_FIVE)."""

    TWO_OF_TWO = "TWO_OF_TWO"
    TWO_OF_THREE = "TWO_OF_THREE"


def _fake_scheme_resolver(name: str) -> FakeThresholdSignatureScheme:
    """Resolve a config string to the fake SDK enum, mirroring the real resolver:
    reject any scheme the SDK does not define (ValueError), else return the enum."""
    try:
        return FakeThresholdSignatureScheme[name]
    except KeyError:
        raise ValueError(f"unsupported Dynamic threshold scheme {name!r}")


@dataclass
class _FakeWalletProperties:
    account_address: str
    wallet_id: str


class FakeEvmWalletClient:
    """Mirrors the documented async ``DynamicEvmWalletClient`` contract."""

    # class-level recorder so a factory closure can read calls back out
    def __init__(self, environment_id: str) -> None:
        self.environment_id = environment_id
        self.calls: list = []
        self.authed_token: str | None = None
        self.entered = 0
        self.exited = 0

    async def __aenter__(self) -> "FakeEvmWalletClient":
        self.entered += 1
        return self

    async def __aexit__(self, *exc) -> bool:
        self.exited += 1
        return False

    async def authenticate_api_token(self, token: str) -> None:
        self.calls.append(("authenticate_api_token", token))
        self.authed_token = token

    async def create_wallet_account(self, *, threshold_signature_scheme, password):
        self.calls.append(
            ("create_wallet_account", threshold_signature_scheme, password)
        )
        return _FakeWalletProperties(
            account_address="0xMPCWALLET", wallet_id="wallet-xyz"
        )

    async def send_transaction(self, *, address, tx, **kwargs):
        self.calls.append(("send_transaction", address, tx, kwargs))
        return "0xdeadbeefTXHASH"


def _factory_capturing(sink: list):
    """A client_factory that records each constructed fake client into ``sink``."""

    def make(environment_id: str) -> FakeEvmWalletClient:
        c = FakeEvmWalletClient(environment_id)
        sink.append(c)
        return c

    return make


# ---- SecretRef --------------------------------------------------------------
def test_secret_ref_resolves_but_never_leaks():
    s = SecretRef("super-secret")
    assert s.resolve() == "super-secret"
    assert "super-secret" not in repr(s)
    assert "super-secret" not in str(s)
    assert repr(s) == "SecretRef(<redacted>)"


def test_secret_ref_lazy_resolver_called_on_demand():
    calls = []

    def resolver():
        calls.append(1)
        return "from-vault"

    s = SecretRef(resolver)
    assert calls == []  # not resolved at construction
    assert s.resolve() == "from-vault"
    assert calls == [1]


def test_secret_ref_from_env(monkeypatch):
    monkeypatch.delenv("CALIBRE_TEST_SECRET", raising=False)
    assert SecretRef.from_env("CALIBRE_TEST_SECRET") is None
    monkeypatch.setenv("CALIBRE_TEST_SECRET", "v")
    assert SecretRef.from_env("CALIBRE_TEST_SECRET").resolve() == "v"


# ---- DynamicServerWallet: provisioning -------------------------------------
def test_provisions_new_wallet_and_persists_only_nonsensitive_metadata():
    clients: list = []
    w = DynamicServerWallet(
        environment_id="env-1",
        api_token=SecretRef("tok-1"),
        password=SecretRef("pw-1"),
        threshold_signature_scheme="TWO_OF_TWO",
        client_factory=_factory_capturing(clients),
        scheme_resolver=_fake_scheme_resolver,
    )
    assert w.address == "0xMPCWALLET"
    assert w.wallet_id == "wallet-xyz"
    # Authenticated with the token, then created the MPC wallet with the scheme.
    c = clients[0]
    assert ("authenticate_api_token", "tok-1") in c.calls
    # The scheme MUST be passed as the SDK enum, not a bare string — a string
    # would silently bypass the real SDK's enum contract. Assert on enum type +
    # value so a regression to a raw string fails this test.
    create_calls = [x for x in c.calls if x[0] == "create_wallet_account"]
    assert len(create_calls) == 1
    _, passed_scheme, passed_pw = create_calls[0]
    assert isinstance(passed_scheme, FakeThresholdSignatureScheme)
    assert passed_scheme is FakeThresholdSignatureScheme.TWO_OF_TWO
    assert not isinstance(passed_scheme, str)
    assert passed_pw == "pw-1"
    # Non-sensitive metadata only — never the password/token.
    meta = w.wallet_metadata
    assert meta == {
        "wallet_id": "wallet-xyz",
        "account_address": "0xMPCWALLET",
        "environment_id": "env-1",
        "threshold_signature_scheme": "TWO_OF_TWO",
    }
    assert "pw-1" not in str(meta) and "tok-1" not in str(meta)


def test_adopts_existing_wallet_without_reprovisioning():
    clients: list = []
    w = DynamicServerWallet(
        environment_id="env-1",
        api_token=SecretRef("tok"),
        wallet_id="existing-1",
        account_address="0xEXISTING",
        client_factory=_factory_capturing(clients),
    )
    assert w.address == "0xEXISTING"
    assert w.wallet_id == "existing-1"
    # No create_wallet_account call when both ids are supplied.
    create_calls = [x for x in clients[0].calls if x[0] == "create_wallet_account"]
    assert create_calls == []


def test_default_scheme_resolver_rejects_unsupported_before_sdk_import():
    """The real resolver rejects a non-SDK scheme by name (THREE_OF_FIVE was never
    a real scheme) BEFORE importing the SDK, so the guard holds without the
    optional dependency installed."""
    with pytest.raises(ValueError):
        _default_scheme_resolver("THREE_OF_FIVE")


def test_provision_rejects_unsupported_scheme():
    """THREE_OF_FIVE (and any non-SDK scheme) is rejected at provision time — the
    SDK supports only TWO_OF_TWO / TWO_OF_THREE."""
    clients: list = []
    with pytest.raises(ValueError):
        DynamicServerWallet(
            environment_id="env-1",
            api_token=SecretRef("tok"),
            threshold_signature_scheme="THREE_OF_FIVE",
            client_factory=_factory_capturing(clients),
            scheme_resolver=_fake_scheme_resolver,
        )


# ---- legacy-tx enforcement (Dynamic SDK signs legacy gasPrice txs only) ------
def test_legacy_tx_strips_eip1559_fee_fields():
    tx = {
        "to": "0xTo", "nonce": 0, "gas": 21000, "gasPrice": 7, "chainId": 1,
        "maxFeePerGas": 99, "maxPriorityFeePerGas": 2, "type": 2,
    }
    out = _legacy_tx(tx)
    assert out["gasPrice"] == 7
    assert "maxFeePerGas" not in out
    assert "maxPriorityFeePerGas" not in out
    assert "type" not in out


def test_legacy_tx_requires_gas_price():
    with pytest.raises(ValueError):
        _legacy_tx({"to": "0xTo", "nonce": 0, "maxFeePerGas": 99,
                    "maxPriorityFeePerGas": 2, "chainId": 1})


def test_send_transaction_hands_sdk_a_legacy_tx():
    """A 1559-shaped tx is coerced to legacy before it reaches the SDK."""
    clients: list = []
    w = DynamicServerWallet(
        environment_id="env-1",
        api_token=SecretRef("tok"),
        wallet_id="w1",
        account_address="0xADDR",
        client_factory=_factory_capturing(clients),
    )
    tx = {"to": "0xTo", "nonce": 0, "gas": 21000, "gasPrice": 5, "chainId": 1,
          "maxFeePerGas": 99, "maxPriorityFeePerGas": 2, "type": 2}
    w.send_transaction(tx)
    _, _, sent_tx, _ = [x for x in clients[-1].calls
                        if x[0] == "send_transaction"][0]
    assert sent_tx["gasPrice"] == 5
    assert "maxFeePerGas" not in sent_tx
    assert "maxPriorityFeePerGas" not in sent_tx
    assert "type" not in sent_tx


# ---- DynamicServerWallet: signing/broadcast --------------------------------
def test_send_transaction_delegates_and_returns_hash():
    clients: list = []
    w = DynamicServerWallet(
        environment_id="env-1",
        api_token=SecretRef("tok"),
        password=SecretRef("pw"),
        wallet_id="w1",
        account_address="0xADDR",
        rpc_url="https://rpc.example",
        client_factory=_factory_capturing(clients),
    )
    tx = {"to": "0xTo", "value": 1, "nonce": 0, "gas": 21000,
          "gasPrice": 7, "chainId": 5042002, "data": "0x"}
    h = w.send_transaction(tx)
    assert h == "0xdeadbeefTXHASH"
    # The signing client (second constructed) carried address + tx + password + rpc.
    sign_client = clients[-1]
    sent = [x for x in sign_client.calls if x[0] == "send_transaction"]
    assert len(sent) == 1
    _, address, sent_tx, kwargs = sent[0]
    assert address == "0xADDR"
    assert sent_tx["to"] == "0xTo" and sent_tx["chainId"] == 5042002
    assert kwargs["password"] == "pw"
    assert kwargs["rpc_url"] == "https://rpc.example"


def test_send_transaction_omits_password_when_none():
    clients: list = []
    w = DynamicServerWallet(
        environment_id="env-1",
        api_token=SecretRef("tok"),
        wallet_id="w1",
        account_address="0xADDR",
        client_factory=_factory_capturing(clients),
    )
    w.send_transaction({"to": "0xTo", "nonce": 0, "gasPrice": 1, "chainId": 1})
    sent = [x for x in clients[-1].calls if x[0] == "send_transaction"][0]
    assert "password" not in sent[3]


def test_repr_never_leaks_token_or_password():
    clients: list = []
    w = DynamicServerWallet(
        environment_id="env-1",
        api_token=SecretRef("tok-SECRET"),
        password=SecretRef("pw-SECRET"),
        wallet_id="w1",
        account_address="0xADDR",
        client_factory=_factory_capturing(clients),
    )
    r = repr(w)
    assert "tok-SECRET" not in r and "pw-SECRET" not in r
    assert "w1" in r and "0xADDR" in r


# ---- build_signer selection -------------------------------------------------
def test_build_signer_picks_dynamic_when_credentials_present(monkeypatch):
    monkeypatch.setenv("DYNAMIC_API_KEY", "tok")
    monkeypatch.delenv("DYNAMIC_WALLET_PASSWORD", raising=False)
    cfg = AgentConfig(
        market_id=1,
        dynamic_api_key="tok",
        dynamic_environment_id="env",
        dynamic_wallet_id="w1",
        dynamic_account_address="0xADDR",  # adopt -> no SDK call needed
    )
    # Patch the default factory so no real SDK import/network happens, even though
    # we adopt an existing wallet (provision still authenticates).
    import calibre_agent.signer as signer_mod

    clients: list = []
    monkeypatch.setattr(signer_mod, "_default_client_factory",
                        _factory_capturing(clients))
    signer = build_signer(cfg)
    assert isinstance(signer, DynamicServerWallet)
    assert signer.address == "0xADDR"


def test_build_signer_falls_back_to_local_key(monkeypatch):
    monkeypatch.delenv("DYNAMIC_API_KEY", raising=False)
    # A valid test private key (well-known eth-account test vector).
    key = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"
    cfg = AgentConfig(market_id=1, agent_private_key=key)
    signer = build_signer(cfg)
    assert isinstance(signer, LocalKeySigner)
    assert signer.address.startswith("0x")


def test_build_signer_raises_when_nothing_configured():
    cfg = AgentConfig(market_id=1)
    with pytest.raises(ValueError):
        build_signer(cfg)
