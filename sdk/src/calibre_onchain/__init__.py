"""calibre_onchain — SDK the private calibre app imports to mirror markets on Arc.

W0 SCAFFOLD — placeholder only. The contract client (``create_market``,
``resolve``) and tx-signing helpers land in W1.x. Public/private boundary: the
SDK's settlement inputs are ``(chain_market_id, outcome)`` only — never LMSR
state, points, or ledger internals.
"""

__version__ = "0.0.0"
