"""Strategy unit tests — pure decide(), no network, no chain."""
from __future__ import annotations

from calibre_agent.config import AgentConfig
from calibre_agent.contract import (
    OUTCOME_NO,
    OUTCOME_UNRESOLVED,
    OUTCOME_YES,
    MarketView,
)
from calibre_agent.maker import ActionKind, decide


def _cfg(**kw) -> AgentConfig:
    base = dict(
        market_id=42,
        size_sets=1,
        inventory_cap_sets=3,
        band_lo_micro=500,
        band_hi_micro=9500,
        spread_micro=200,
    )
    base.update(kw)
    return AgentConfig(**base)


def _open(yes=0, no=0) -> MarketView:
    return MarketView(exists=True, outcome=OUTCOME_UNRESOLVED, yes_shares=yes, no_shares=no)


def test_mint_in_band_under_cap():
    a = decide(_cfg(), price_yes=5000, view=_open())
    assert a.kind is ActionKind.MINT
    assert a.sets == 1
    assert a.quote_lo_micro == 4800 and a.quote_hi_micro == 5200


def test_hold_below_band():
    a = decide(_cfg(), price_yes=300, view=_open())
    assert a.kind is ActionKind.HOLD
    assert "outside band" in a.reason


def test_hold_above_band():
    a = decide(_cfg(), price_yes=9800, view=_open())
    assert a.kind is ActionKind.HOLD


def test_hold_at_inventory_cap():
    # net_sets = min(3,3) = 3; +1 would exceed cap 3.
    a = decide(_cfg(), price_yes=5000, view=_open(yes=3, no=3))
    assert a.kind is ActionKind.HOLD
    assert "cap" in a.reason


def test_mint_just_under_cap():
    # net_sets = 2; +1 == cap 3, allowed.
    a = decide(_cfg(), price_yes=5000, view=_open(yes=2, no=2))
    assert a.kind is ActionKind.MINT


def test_redeem_when_resolved_yes_with_winnings():
    v = MarketView(exists=True, outcome=OUTCOME_YES, yes_shares=2, no_shares=2)
    a = decide(_cfg(), price_yes=5000, view=v)
    assert a.kind is ActionKind.REDEEM


def test_hold_when_resolved_no_winnings():
    # resolved NO but agent holds no NO shares.
    v = MarketView(exists=True, outcome=OUTCOME_NO, yes_shares=2, no_shares=0)
    a = decide(_cfg(), price_yes=5000, view=v)
    assert a.kind is ActionKind.HOLD


def test_quote_band_clamped_to_valid_range():
    a = decide(_cfg(spread_micro=10000), price_yes=600, view=_open())
    assert a.quote_lo_micro == 1 and a.quote_hi_micro == 9999
