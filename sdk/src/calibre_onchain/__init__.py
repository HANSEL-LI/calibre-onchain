"""calibre_onchain — SDK the private calibre app imports to mirror markets on Arc.

The contract client (``create_market``, ``resolve``) + tx-signing helpers the
private calibre app imports for Seam 1 (calibre #425). The SDK's settlement
inputs are ``(chain_market_id, outcome)`` only — never LMSR state, points, or
ledger internals (see the repo root README for the public/private boundary).

``OnchainClient`` / ``OnchainConfig`` are exported here, but web3 is imported
only at ``OnchainClient(...)`` construction (not at module import), so the
private app can ``from calibre_onchain import OnchainClient`` behind a feature
flag without forcing the web3 stack on its flag-off boot path.
"""

from calibre_onchain.client import OnchainClient, OnchainConfig

__version__ = "0.1.0"

__all__ = ["OnchainClient", "OnchainConfig", "__version__"]
