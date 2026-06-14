"""AgentConfig — all knobs for the standalone market-maker agent.

Read from the environment via :func:`AgentConfig.from_env`. Every value has a
safe default biased toward *not* spending money: ``dry_run`` is on, the
inventory cap is small, and the price band excludes degenerate near-0/near-1
prices. The only required value is the market id to make on.

Money / price units (matching calibre and the W7.1 public endpoint):
- ``price_yes`` is in **micro-cents**, range ``[1, 9999]``; ``10000`` == prob 1.0.
- The Arc ``CalibreMarket`` contract denominates one complete set in
  ``usdcUnit = 10**usdc.decimals()`` base units (6-decimal ERC-20 USDC), so
  ``sets`` here is whole complete sets.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return float(raw) if raw not in (None, "") else default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw in (None, ""):
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class AgentConfig:
    """Connection, strategy, and risk-bound config for one market."""

    # --- what to make on ---
    market_id: int
    """The calibre market id; also the on-chain ``chainMarketId`` (Seam 1 mirrors
    the same id on-chain, so the public price id and the contract id are one)."""

    # --- calibre public signal (Seam 4: public read only, no auth) ---
    public_api_base: str = "https://app.hicalibre.gg/api/v1"

    # --- Arc chain ---
    rpc_url: str = "https://rpc.testnet.arc.network"
    chain_id: int = 5042002  # Arc testnet (W8 spike §3)
    contract_address: str = ""  # deployed CalibreMarket; empty until W1.3 deploy
    usdc_address: str = ""  # the 6-decimal ERC-20 USDC on Arc

    # --- signer (one of these selects the signer; server-wallet wins) ---
    # The Dynamic MPC server wallet (#618) uses the documented `dynamic-wallet-sdk`
    # Python client; the sensitive material (DYNAMIC_API_KEY and an optional wallet
    # password) is read from the env as a SecretRef in build_signer, NOT stored on
    # this frozen dataclass. Only non-sensitive metadata lives here.
    dynamic_environment_id: str = ""
    dynamic_api_key: str = ""
    """The Dynamic API token (sensitive). Presence here selects the server-wallet
    path; build_signer prefers $DYNAMIC_API_KEY via a SecretRef so it is never
    logged. Kept on config only so `uses_server_wallet()` can gate on it."""
    dynamic_wallet_id: str = ""  # an existing Dynamic MPC wallet id, if any
    dynamic_account_address: str = ""
    """The existing wallet's on-chain address. Supplying both this and
    `dynamic_wallet_id` adopts an already-provisioned wallet (no re-provision);
    leaving them empty provisions a fresh MPC wallet at startup."""
    dynamic_threshold_scheme: str = "TWO_OF_TWO"
    """MPC threshold signature scheme passed to create_wallet_account, resolved to
    the SDK's ``ThresholdSignatureScheme`` enum in the signer. The SDK supports
    exactly ``TWO_OF_TWO`` and ``TWO_OF_THREE``; ``TWO_OF_TWO`` is the default for a
    single-server-controlled agent wallet (server + Dynamic each hold one share)."""
    agent_private_key: str = ""  # local-key fallback (testnet only)

    # --- voucher source (W1.2 buy leg; one of these selects the source) ---
    calibre_voucher_api_base: str = ""
    """Calibre's quote/sign endpoint (W3.1, private app). When set, the agent
    fetches a backend-signed voucher from it (the production path)."""
    calibre_voucher_api_key: str = ""
    """Optional bearer for the calibre voucher endpoint."""
    agent_voucher_signer_key: str = ""
    """Local voucherSigner key — the offline/testnet fallback that signs the
    EIP-712 voucher locally so the agent buys with no calibre backend. TESTNET
    ONLY. This is the contract's ``voucherSigner`` key, distinct from the agent's
    tx-signing key (``AGENT_PRIVATE_KEY`` / the Dynamic server wallet)."""

    # --- strategy ---
    size_sets: int = 1
    """Complete sets minted per action (the fixed maker size)."""
    spread_micro: int = 200
    """Half-spread in micro-cents; the band the maker advertises around the
    prior. With no on-chain order book this is recorded/logged, not posted."""

    # --- risk bounds (a bug must be bounded) ---
    inventory_cap_sets: int = 10
    """Never mint past this many net complete sets on the market."""
    band_lo_micro: int = 500
    """Skip minting when the prior is below this (near-0 degenerate)."""
    band_hi_micro: int = 9500
    """Skip minting when the prior is above this (near-1 degenerate)."""

    # --- loop ---
    poll_interval_s: float = 15.0
    max_iterations: int = 0
    """0 == run until killed; >0 caps the demo window."""
    kill_switch_file: str = ""
    """If set and the file exists, the loop halts new actions each tick."""
    dry_run: bool = True
    """Log intended actions without sending transactions. Default ON; flip to
    ``false`` only once the wallet is funded and you accept the bounded spend."""

    extra: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "AgentConfig":
        market_id = _env_int("AGENT_MARKET_ID", 0)
        if market_id <= 0:
            raise ValueError("AGENT_MARKET_ID must be set to a positive market id")
        return cls(
            market_id=market_id,
            public_api_base=os.environ.get(
                "CALIBRE_PUBLIC_API_BASE", cls.public_api_base
            ).rstrip("/"),
            rpc_url=os.environ.get("ARC_RPC_URL", cls.rpc_url),
            chain_id=_env_int("ARC_CHAIN_ID", cls.chain_id) or cls.chain_id,
            contract_address=os.environ.get("CALIBRE_MARKET_ADDRESS", ""),
            usdc_address=os.environ.get("ARC_USDC_ADDRESS", ""),
            dynamic_environment_id=os.environ.get("DYNAMIC_ENVIRONMENT_ID", ""),
            dynamic_api_key=os.environ.get("DYNAMIC_API_KEY", ""),
            dynamic_wallet_id=os.environ.get("DYNAMIC_WALLET_ID", ""),
            dynamic_account_address=os.environ.get("DYNAMIC_ACCOUNT_ADDRESS", ""),
            dynamic_threshold_scheme=os.environ.get(
                "DYNAMIC_THRESHOLD_SCHEME", cls.dynamic_threshold_scheme
            ),
            agent_private_key=os.environ.get("AGENT_PRIVATE_KEY", ""),
            calibre_voucher_api_base=os.environ.get(
                "CALIBRE_VOUCHER_API_BASE", ""
            ).rstrip("/"),
            calibre_voucher_api_key=os.environ.get("CALIBRE_VOUCHER_API_KEY", ""),
            agent_voucher_signer_key=os.environ.get("AGENT_VOUCHER_SIGNER_KEY", ""),
            size_sets=_env_int("AGENT_SIZE_SETS", cls.size_sets),
            spread_micro=_env_int("AGENT_SPREAD_MICRO", cls.spread_micro),
            inventory_cap_sets=_env_int(
                "AGENT_INVENTORY_CAP_SETS", cls.inventory_cap_sets
            ),
            band_lo_micro=_env_int("AGENT_BAND_LO_MICRO", cls.band_lo_micro),
            band_hi_micro=_env_int("AGENT_BAND_HI_MICRO", cls.band_hi_micro),
            poll_interval_s=_env_float("AGENT_POLL_INTERVAL_S", cls.poll_interval_s),
            max_iterations=_env_int("AGENT_MAX_ITERATIONS", cls.max_iterations),
            kill_switch_file=os.environ.get("AGENT_KILL_SWITCH_FILE", ""),
            dry_run=_env_bool("AGENT_DRY_RUN", cls.dry_run),
        )

    def uses_server_wallet(self) -> bool:
        """True when Dynamic server-wallet credentials are present (the bounty
        path); else the local-key fallback signs."""
        return bool(self.dynamic_api_key and self.dynamic_environment_id)
