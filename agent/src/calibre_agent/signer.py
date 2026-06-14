"""Signer — how the agent puts its name on an Arc transaction.

Two implementations behind one tiny protocol so the agent runs both ways:

- :class:`DynamicServerWallet` — the **Dynamic agentic-bounty path** (#618). The
  agent owns a Dynamic **MPC server wallet** (a backend-controlled threshold-
  signature wallet, distinct from a user's embedded wallet) and delegates signing
  to Dynamic's documented Python SDK (``dynamic-wallet-sdk``: the
  ``DynamicEvmWalletClient`` → ``authenticate_api_token`` →
  ``create_wallet_account(threshold_signature_scheme=…)`` → ``send_transaction`` /
  ``sign_transaction`` contract). Selected when ``DYNAMIC_API_KEY`` +
  ``DYNAMIC_ENVIRONMENT_ID`` are set. The single private key never exists: your
  server and Dynamic each hold a key share (TSS-MPC). Real credentials + a funded
  Arc server wallet are owner/booth-gated, so this class isolates the whole SDK
  surface; the agent still *constructs* the transaction the same way either path.

- :class:`LocalKeySigner` — a local ``eth-account`` key signer (the same
  primitive the merged ``sdk`` uses) so the artifact runs against Arc testnet
  with no Dynamic account. Selected when only ``AGENT_PRIVATE_KEY`` is set.

Signer seam (two shapes, because the two SDKs differ — see the #618 plan):

- Every signer exposes ``address``.
- A **broadcasting** signer (the Dynamic SDK ``send_transaction`` signs *and*
  broadcasts in one MPC round-trip, returning a tx hash) exposes
  ``send_transaction(tx) -> tx_hash``.
- A **raw-bytes** signer (``eth-account``) exposes ``sign_transaction(tx) ->
  raw_bytes`` and lets :class:`~calibre_agent.contract.MarketClient` broadcast.

``MarketClient`` prefers ``send_transaction`` when the signer provides it. We do
*not* reconstruct serialized raw bytes from the Dynamic SDK's bare 65-byte
signature — that is not a documented SDK capability, so it would be guessing.

Sensitive MPC material (the wallet ``password`` that encrypts/unlocks the key
shares; #618 "externalServerKeyShares never logged, never a plaintext column")
is held behind :class:`SecretRef` so it is fetched lazily and redacted from logs
/ reprs. Only the non-sensitive ``wallet_id`` + ``account_address`` are persisted.
"""
from __future__ import annotations

import os
from typing import Callable, Optional, Protocol, runtime_checkable


class Signer(Protocol):
    """Anything that can name an Arc transaction for the agent."""

    @property
    def address(self) -> str: ...


@runtime_checkable
class RawSigner(Protocol):
    """A signer that returns raw signed-tx bytes for the client to broadcast."""

    @property
    def address(self) -> str: ...

    def sign_transaction(self, tx: dict) -> bytes:
        """Return the raw signed-transaction bytes for ``tx`` (a built web3 txn
        dict including ``chainId``, ``nonce``, ``from``, gas fields)."""
        ...


@runtime_checkable
class BroadcastingSigner(Protocol):
    """A signer that signs *and* broadcasts in one call, returning a tx hash.

    The Dynamic MPC SDK's ``send_transaction`` is this shape (it owns the
    JSON-RPC round-trip), so the client cannot just take raw bytes from it.
    """

    @property
    def address(self) -> str: ...

    def send_transaction(self, tx: dict) -> str:
        """Sign + broadcast ``tx``; return the ``0x``-prefixed tx hash."""
        ...


class SecretRef:
    """A lazily-resolved, log-safe handle to a sensitive value.

    The sensitive MPC material (the wallet password that unlocks the Dynamic-
    held key shares) is never stored as a plain attribute and never logged: the
    value is produced on demand by ``resolver`` (e.g. a KMS/Secret-Manager
    fetch) and ``repr`` / ``str`` are redacted. A bare string is wrapped as a
    constant resolver for local/testnet convenience.

    Map to a real vault by passing a resolver that reads AWS KMS / GCP Secret
    Manager / Azure Key Vault — the issue's storage invariant. Never put the
    value in a plaintext DB column.
    """

    __slots__ = ("_resolver",)

    def __init__(self, resolver: "str | Callable[[], str]") -> None:
        if isinstance(resolver, str):
            value = resolver
            self._resolver: Callable[[], str] = lambda: value
        else:
            self._resolver = resolver

    def resolve(self) -> str:
        return self._resolver()

    def __repr__(self) -> str:  # never leak the value
        return "SecretRef(<redacted>)"

    __str__ = __repr__

    @classmethod
    def from_env(cls, name: str) -> "Optional[SecretRef]":
        """Wrap ``$name`` as a SecretRef, or None if unset/empty."""
        raw = os.environ.get(name)
        return cls(raw) if raw else None


class LocalKeySigner:
    """Sign with a local private key via ``eth-account``. Testnet only."""

    def __init__(self, private_key: str) -> None:
        from eth_account import Account

        self._account = Account.from_key(private_key)

    @property
    def address(self) -> str:
        return self._account.address

    def sign_transaction(self, tx: dict) -> bytes:
        signed = self._account.sign_transaction(tx)
        return signed.raw_transaction


class DynamicServerWallet:
    """Sign through a Dynamic **MPC server wallet** (the agentic-bounty path, #618).

    Wraps the documented ``dynamic-wallet-sdk`` Python client. On construction it
    authenticates the API token, then either loads an existing wallet
    (``wallet_id`` + ``account_address`` supplied) or provisions a fresh MPC
    wallet via ``create_wallet_account(threshold_signature_scheme=…, password=…)``
    and exposes the non-sensitive metadata the caller persists. Each
    :meth:`send_transaction` delegates to the SDK's MPC ``send_transaction``,
    which signs (your share + Dynamic's share) and broadcasts in one call.

    The whole SDK surface — async client, method/param names, the legacy-tx
    constraint — is isolated here so it never leaks into the agent loop. The
    sensitive wallet ``password`` lives behind a :class:`SecretRef`: resolved
    lazily at sign time, redacted from logs, never a plaintext column.

    The SDK is async; this exposes a sync facade (the agent loop is sync) by
    driving each call on a private event loop. ``client_factory`` is injectable
    so tests fake the SDK to its real documented contract without a network.
    """

    def __init__(
        self,
        *,
        environment_id: str,
        api_token: SecretRef,
        password: Optional[SecretRef] = None,
        threshold_signature_scheme: str = "TWO_OF_TWO",
        wallet_id: str = "",
        account_address: str = "",
        rpc_url: str = "",
        client_factory: Optional[Callable[[str], object]] = None,
        scheme_resolver: Optional[Callable[[str], object]] = None,
    ) -> None:
        self._environment_id = environment_id
        self._api_token = api_token
        self._password = password
        self._scheme = threshold_signature_scheme
        self._rpc_url = rpc_url
        self._client_factory = client_factory or _default_client_factory
        # Resolve the config string to the SDK's ThresholdSignatureScheme enum so
        # create_wallet_account receives the documented enum, not a bare string
        # (the SDK rejects an unknown string). Injectable for the faithful fake.
        self._scheme_resolver = scheme_resolver or _default_scheme_resolver

        self._wallet_id = wallet_id
        self._account_address = account_address
        self._provision_or_load()

    # -- Dynamic SDK surface (isolated to this class) ------------------------
    def _provision_or_load(self) -> None:
        """Authenticate, then provision a new MPC wallet or adopt the supplied
        one. Persist only the non-sensitive ``wallet_id`` + ``account_address``."""

        async def _run() -> None:
            client = self._client_factory(self._environment_id)
            async with client as c:  # SDK is an async context manager
                await c.authenticate_api_token(self._api_token.resolve())
                if not self._wallet_id or not self._account_address:
                    props = await c.create_wallet_account(
                        threshold_signature_scheme=self._scheme_resolver(
                            self._scheme
                        ),
                        password=self._resolve_password(),
                    )
                    # WalletProperties: non-sensitive identity fields only.
                    self._wallet_id = str(props.wallet_id)
                    self._account_address = str(props.account_address)

        _await(_run())

    def _resolve_password(self) -> Optional[str]:
        return self._password.resolve() if self._password is not None else None

    @property
    def address(self) -> str:
        return self._account_address

    @property
    def wallet_id(self) -> str:
        """Non-sensitive wallet id — safe to persist in Postgres."""
        return self._wallet_id

    @property
    def wallet_metadata(self) -> dict:
        """The non-sensitive metadata to persist (never the key material)."""
        return {
            "wallet_id": self._wallet_id,
            "account_address": self._account_address,
            "environment_id": self._environment_id,
            "threshold_signature_scheme": self._scheme,
        }

    def send_transaction(self, tx: dict) -> str:
        """Sign (MPC) + broadcast ``tx`` via the Dynamic SDK; return the tx hash.

        The SDK signs only **legacy** transactions (``gasPrice``, no EIP-1559
        fields) and owns the JSON-RPC broadcast, so this is a
        :class:`BroadcastingSigner`, not a raw-bytes signer. The tx is coerced to
        a legacy shape via :func:`_legacy_tx` before it reaches the SDK (which
        rejects EIP-1559 fee fields); ``MarketClient`` already builds legacy on
        this path, this is the defensive backstop.
        """

        legacy_tx = _legacy_tx(tx)

        async def _run() -> str:
            client = self._client_factory(self._environment_id)
            async with client as c:
                await c.authenticate_api_token(self._api_token.resolve())
                kwargs: dict = {
                    "address": self._account_address,
                    "tx": _jsonable_tx(legacy_tx),
                }
                if self._password is not None:
                    kwargs["password"] = self._resolve_password()
                if self._rpc_url:
                    kwargs["rpc_url"] = self._rpc_url
                return str(await c.send_transaction(**kwargs))

        return _await(_run())

    def __repr__(self) -> str:  # never leak the token/password
        return (
            f"DynamicServerWallet(env={self._environment_id!r}, "
            f"wallet_id={self._wallet_id!r}, address={self._account_address!r})"
        )


# The schemes the dynamic-wallet-sdk actually supports (no THREE_OF_FIVE — that
# was never a real SDK scheme). TWO_OF_TWO suits a single-server-controlled agent
# wallet (server + Dynamic each hold one share).
_SUPPORTED_SCHEMES = ("TWO_OF_TWO", "TWO_OF_THREE")


def _default_scheme_resolver(name: str):
    """Map a config scheme string to the SDK's ``ThresholdSignatureScheme`` enum.

    The real SDK's ``create_wallet_account`` expects the enum, not a bare string,
    so we resolve here and reject any name the SDK does not define. Lazy import so
    the testnet artifact installs without the optional SDK."""
    if name not in _SUPPORTED_SCHEMES:
        raise ValueError(
            f"unsupported Dynamic threshold scheme {name!r}; "
            f"the dynamic-wallet-sdk supports only {', '.join(_SUPPORTED_SCHEMES)}"
        )
    try:
        from dynamic_wallet_sdk import ThresholdSignatureScheme
    except ImportError as exc:  # pragma: no cover - import-guard
        raise RuntimeError(
            "the Dynamic server-wallet path needs the 'dynamic-wallet-sdk' "
            "package: pip install 'calibre-agent[server-wallet]'"
        ) from exc
    return ThresholdSignatureScheme[name]


def _default_client_factory(environment_id: str):
    """Construct the real Dynamic Python SDK client (lazy import so the testnet
    artifact installs without the optional ``dynamic-wallet-sdk`` dependency)."""
    try:
        from dynamic_wallet_sdk import DynamicEvmWalletClient
    except ImportError as exc:  # pragma: no cover - import-guard
        raise RuntimeError(
            "the Dynamic server-wallet path needs the 'dynamic-wallet-sdk' "
            "package: pip install 'calibre-agent[server-wallet]'"
        ) from exc
    return DynamicEvmWalletClient(environment_id)


def _await(coro):
    """Run an awaitable to completion on a private event loop (the agent loop is
    sync; the Dynamic SDK is async)."""
    import asyncio

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# EIP-1559 fee fields the Dynamic SDK does not accept (legacy "gasPrice" only).
_EIP1559_FIELDS = ("maxFeePerGas", "maxPriorityFeePerGas", "type", "accessList")


def _legacy_tx(tx: dict) -> dict:
    """Coerce ``tx`` to the legacy shape the Dynamic SDK requires: strip any
    EIP-1559 fee fields and require a ``gasPrice``.

    The Dynamic SDK signs only legacy txs (``gasPrice``, no ``maxFeePerGas`` /
    ``maxPriorityFeePerGas``). ``MarketClient._send`` already pins ``gasPrice``
    when it builds for a broadcasting signer; this is the defensive backstop so
    a 1559-shaped tx can never reach the SDK from any caller."""
    legacy = {k: v for k, v in tx.items() if k not in _EIP1559_FIELDS}
    if "gasPrice" not in legacy or legacy["gasPrice"] in (None, ""):
        raise ValueError(
            "Dynamic server wallet requires a legacy tx with 'gasPrice' "
            "(no EIP-1559 maxFeePerGas/maxPriorityFeePerGas)"
        )
    return legacy


def _jsonable_tx(tx: dict) -> dict:
    """Coerce a web3 txn dict to plain JSON (ints stay ints; hex stays str)."""
    return {k: (v if isinstance(v, (int, str)) else str(v)) for k, v in tx.items()}


def build_signer(config) -> Signer:
    """Pick the signer from config: Dynamic MPC server wallet if its credentials
    are present (the bounty path), else the local-key fallback. Raises if neither
    is configured."""
    if config.uses_server_wallet():
        api_token = SecretRef.from_env("DYNAMIC_API_KEY") or SecretRef(
            config.dynamic_api_key
        )
        password = SecretRef.from_env("DYNAMIC_WALLET_PASSWORD")
        return DynamicServerWallet(
            environment_id=config.dynamic_environment_id,
            api_token=api_token,
            password=password,
            threshold_signature_scheme=config.dynamic_threshold_scheme,
            wallet_id=config.dynamic_wallet_id,
            account_address=config.dynamic_account_address,
            rpc_url=config.rpc_url,
        )
    if config.agent_private_key:
        return LocalKeySigner(config.agent_private_key)
    raise ValueError(
        "no signer configured: set DYNAMIC_API_KEY + DYNAMIC_ENVIRONMENT_ID "
        "(server-wallet path) or AGENT_PRIVATE_KEY (local testnet fallback)"
    )
