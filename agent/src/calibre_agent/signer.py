"""Signer — how the agent puts its name on an Arc transaction.

Two implementations behind one tiny protocol so the agent runs both ways:

- :class:`DynamicServerWallet` — the **Dynamic agentic-bounty path**. The agent
  owns a Dynamic *server* wallet (a backend-controlled wallet, distinct from a
  user's embedded/MPC wallet) and asks Dynamic's wallet API to sign the raw
  transaction. Selected when ``DYNAMIC_API_KEY`` + ``DYNAMIC_ENVIRONMENT_ID`` are
  set. Real credentials + a funded Arc server wallet are owner/booth-gated, so
  this class is isolated and the request shape is documented from Dynamic's API;
  the agent still *constructs* the transaction the same way either path.

- :class:`LocalKeySigner` — a local ``eth-account`` key signer (the same
  primitive the merged ``sdk`` uses) so the artifact runs against Arc testnet
  with no Dynamic account. Selected when only ``AGENT_PRIVATE_KEY`` is set.

Both expose ``address`` and ``sign_transaction(tx) -> raw_bytes``; broadcasting
is the contract client's job (it owns the web3 provider).
"""
from __future__ import annotations

from typing import Protocol


class Signer(Protocol):
    """Anything that can name + sign an Arc transaction for the agent."""

    @property
    def address(self) -> str: ...

    def sign_transaction(self, tx: dict) -> bytes:
        """Return the raw signed-transaction bytes for ``tx`` (a built web3 txn
        dict including ``chainId``, ``nonce``, ``from``, gas fields)."""
        ...


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
    """Sign through a Dynamic **server wallet** (the agentic-bounty path).

    The agent holds a server wallet provisioned in its Dynamic environment and
    delegates signing to Dynamic's wallet API. The wallet's address is fetched
    once at construction; each ``sign_transaction`` POSTs the unsigned txn to the
    wallet's sign endpoint and returns the raw signed bytes.

    The exact endpoint/field names live only here, behind this class, so if a
    field is booth-confirmed-only it does not leak into the agent loop. Both
    signers produce the identical artifact (raw signed bytes), so swapping
    signers never touches the strategy or loop code.
    """

    def __init__(
        self,
        *,
        api_base: str,
        api_key: str,
        environment_id: str,
        wallet_id: str = "",
        client=None,
    ) -> None:
        import httpx

        self._api_base = api_base.rstrip("/")
        self._environment_id = environment_id
        self._wallet_id = wallet_id
        self._client = client or httpx.Client(
            timeout=20.0,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )
        if not self._wallet_id:
            self._wallet_id = self._provision_wallet()
        self._address = self._load_address(self._wallet_id)

    # -- Dynamic wallet API surface (isolated to this class) -----------------
    def _provision_wallet(self) -> str:
        """Create a server wallet in the environment and return its id."""
        url = f"{self._api_base}/environments/{self._environment_id}/wallets"
        resp = self._client.post(url, json={"type": "server"})
        resp.raise_for_status()
        return str(resp.json()["walletId"])

    def _load_address(self, wallet_id: str) -> str:
        url = f"{self._api_base}/wallets/{wallet_id}"
        resp = self._client.get(url)
        resp.raise_for_status()
        return str(resp.json()["address"])

    @property
    def address(self) -> str:
        return self._address

    def sign_transaction(self, tx: dict) -> bytes:
        """Ask Dynamic to sign the unsigned transaction; return raw bytes."""
        url = f"{self._api_base}/wallets/{self._wallet_id}/transactions/sign"
        resp = self._client.post(url, json={"transaction": _jsonable_tx(tx)})
        resp.raise_for_status()
        signed_hex = resp.json()["signedTransaction"]
        return bytes.fromhex(signed_hex[2:] if signed_hex.startswith("0x") else signed_hex)


def _jsonable_tx(tx: dict) -> dict:
    """Coerce a web3 txn dict to plain JSON (ints stay ints; hex stays str)."""
    return {k: (v if isinstance(v, (int, str)) else str(v)) for k, v in tx.items()}


def build_signer(config) -> Signer:
    """Pick the signer from config: Dynamic server wallet if its credentials are
    present (the bounty path), else the local-key fallback. Raises if neither is
    configured."""
    if config.uses_server_wallet():
        return DynamicServerWallet(
            api_base=config.dynamic_api_base,
            api_key=config.dynamic_api_key,
            environment_id=config.dynamic_environment_id,
            wallet_id=config.dynamic_wallet_id,
        )
    if config.agent_private_key:
        return LocalKeySigner(config.agent_private_key)
    raise ValueError(
        "no signer configured: set DYNAMIC_API_KEY + DYNAMIC_ENVIRONMENT_ID "
        "(server-wallet path) or AGENT_PRIVATE_KEY (local testnet fallback)"
    )
