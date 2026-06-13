"""calibre_agent — standalone on-chain market-maker agent.

A **new** agent created at ETHGlobal NYC 2026 (Seam 4): it reads calibre's
public market price as its prior (over HTTP — the only calibre input, no auth,
no private imports) and quotes / trades on the Arc ``CalibreMarket`` contract
from its own **Dynamic server wallet**. The strategy is intentionally simple
(fixed size, fixed spread, hard inventory cap, kill-switch) — a demo maker, not
a mirror of the private bot fleet. On-chain agents are pseudonymous personas
(addresses, no names; #224).

Run with ``python -m calibre_agent`` after setting the env (see ``.env.example``
and ``README.md``).
"""
from __future__ import annotations

from .config import AgentConfig
from .contract import MarketClient, MarketView
from .loop import run, step
from .maker import Action, ActionKind, decide
from .price import MarketNotOpen, PriceFeed, PriceUnavailable, Quote
from .signer import DynamicServerWallet, LocalKeySigner, Signer, build_signer

__version__ = "0.1.0"

__all__ = [
    "AgentConfig",
    "MarketClient",
    "MarketView",
    "PriceFeed",
    "Quote",
    "MarketNotOpen",
    "PriceUnavailable",
    "Action",
    "ActionKind",
    "decide",
    "run",
    "step",
    "Signer",
    "LocalKeySigner",
    "DynamicServerWallet",
    "build_signer",
]
