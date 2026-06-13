"""MarketMaker — one decide-and-act step. Intentionally simple.

This is a **demo** maker, not the private stack: fixed size, fixed spread, a
hard inventory cap, and a price band. The decision each tick:

1. Read the agent's on-chain state for the market.
2. If the market has **resolved** on-chain and the agent still holds winning
   shares → **redeem** (close the position, recycle USDC).
3. Else, if the prior sits inside the sane band **and** net inventory is under
   the cap → **mint** ``size`` complete sets (provisioning two-sided inventory
   at the prior — what an LMSR maker holds; the fixed spread is the band it
   advertises around the prior).
4. Otherwise → **hold** (out of band, at the cap, or unresolved-with-nothing).

The strategy is pure given (quote, view, config): it returns a typed
:class:`Action` and never touches the chain itself — the loop executes it. That
keeps it unit-testable with a fake feed/contract and makes the risk bounds
explicit and auditable.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .config import AgentConfig
from .contract import OUTCOME_YES, MarketView


class ActionKind(str, Enum):
    HOLD = "hold"
    MINT = "mint"
    REDEEM = "redeem"


@dataclass(frozen=True)
class Action:
    """The maker's decision for one tick."""

    kind: ActionKind
    sets: int = 0
    reason: str = ""
    quote_lo_micro: int | None = None
    quote_hi_micro: int | None = None


def decide(config: AgentConfig, price_yes: int, view: MarketView) -> Action:
    """Pure strategy: pick the action for this tick. ``price_yes`` is the public
    prior in micro-cents; ``view`` is the agent's on-chain state."""
    # 1) resolved → redeem any winnings, else nothing to do.
    if view.resolved:
        winning = view.yes_shares if view.outcome == OUTCOME_YES else view.no_shares
        if winning > 0:
            return Action(ActionKind.REDEEM, reason="market resolved; redeeming winnings")
        return Action(ActionKind.HOLD, reason="resolved; no winning shares")

    # 2) band gate — skip degenerate near-0 / near-1 priors.
    if price_yes < config.band_lo_micro or price_yes > config.band_hi_micro:
        return Action(
            ActionKind.HOLD,
            reason=f"prior {price_yes} outside band "
            f"[{config.band_lo_micro},{config.band_hi_micro}]",
        )

    # 3) inventory cap — never mint past the cap.
    if view.net_sets + config.size_sets > config.inventory_cap_sets:
        return Action(
            ActionKind.HOLD,
            reason=f"inventory {view.net_sets} at/near cap "
            f"{config.inventory_cap_sets}",
        )

    # 4) make: mint size sets, advertising the fixed-spread band around prior.
    lo = max(1, price_yes - config.spread_micro)
    hi = min(9999, price_yes + config.spread_micro)
    return Action(
        ActionKind.MINT,
        sets=config.size_sets,
        reason=f"making at prior {price_yes} ±{config.spread_micro}",
        quote_lo_micro=lo,
        quote_hi_micro=hi,
    )
