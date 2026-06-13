"""Loop tests with fakes — exercise step/run without network or chain."""
from __future__ import annotations

from calibre_agent.config import AgentConfig
from calibre_agent.contract import OUTCOME_UNRESOLVED, OUTCOME_YES, MarketView
from calibre_agent.loop import run, step
from calibre_agent.maker import ActionKind
from calibre_agent.price import Quote


class FakeFeed:
    def __init__(self, price: int):
        self.price = price

    def fetch(self, market_id: int) -> Quote:
        return Quote(market_id=market_id, price_yes=self.price, as_of=123)


class FakeClient:
    def __init__(self, view: MarketView):
        self._view = view
        self.address = "0xAGENT"
        self.minted = []
        self.redeemed = []
        self.approved = []

    def view(self, market_id: int) -> MarketView:
        return self._view

    def ensure_allowance(self, sets: int):
        self.approved.append(sets)
        return None

    def mint(self, market_id: int, sets: int) -> str:
        self.minted.append((market_id, sets))
        return "0xmint"

    def redeem(self, market_id: int) -> str:
        self.redeemed.append(market_id)
        return "0xredeem"


def _cfg(**kw) -> AgentConfig:
    base = dict(market_id=42, inventory_cap_sets=3, size_sets=1, dry_run=False)
    base.update(kw)
    return AgentConfig(**base)


def _open(yes=0, no=0):
    return MarketView(exists=True, outcome=OUTCOME_UNRESOLVED, yes_shares=yes, no_shares=no)


def test_step_mints_when_live():
    client = FakeClient(_open())
    action = step(_cfg(), FakeFeed(5000), client)
    assert action.kind is ActionKind.MINT
    assert client.minted == [(42, 1)]
    assert client.approved == [1]


def test_step_dry_run_does_not_act():
    client = FakeClient(_open())
    action = step(_cfg(dry_run=True), FakeFeed(5000), client)
    assert action.kind is ActionKind.MINT  # decided...
    assert client.minted == []              # ...but not executed
    assert client.approved == []


def test_step_redeems_after_resolve():
    v = MarketView(exists=True, outcome=OUTCOME_YES, yes_shares=2, no_shares=2)
    client = FakeClient(v)
    action = step(_cfg(), FakeFeed(5000), client)
    assert action.kind is ActionKind.REDEEM
    assert client.redeemed == [42]


def test_run_stops_at_max_iterations():
    client = FakeClient(_open())
    slept = []
    ticks = run(_cfg(max_iterations=3, dry_run=True), FakeFeed(5000), client,
                sleep=slept.append)
    assert ticks == 3
    # no sleep after the final tick (it breaks at the top-of-loop guard).
    assert len(slept) == 2


def test_run_halts_on_kill_switch(tmp_path):
    ks = tmp_path / "STOP"
    ks.write_text("halt")
    client = FakeClient(_open())
    ticks = run(_cfg(kill_switch_file=str(ks), dry_run=True), FakeFeed(5000),
                client, sleep=lambda _s: None)
    assert ticks == 0
    assert client.minted == []


def test_run_respects_inventory_cap_unattended():
    # At cap → every tick holds, never mints, even live.
    client = FakeClient(_open(yes=3, no=3))
    ticks = run(_cfg(max_iterations=5), FakeFeed(5000), client, sleep=lambda _s: None)
    assert ticks == 5
    assert client.minted == []
