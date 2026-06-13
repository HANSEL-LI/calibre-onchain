"""Config-from-env + PriceFeed parsing tests (no real network)."""
from __future__ import annotations

import httpx
import pytest

from calibre_agent.config import AgentConfig
from calibre_agent.price import MarketNotOpen, PriceFeed, PriceUnavailable


# ---- config ----------------------------------------------------------------
def test_from_env_requires_market_id(monkeypatch):
    monkeypatch.delenv("AGENT_MARKET_ID", raising=False)
    with pytest.raises(ValueError):
        AgentConfig.from_env()


def test_from_env_reads_overrides(monkeypatch):
    monkeypatch.setenv("AGENT_MARKET_ID", "7")
    monkeypatch.setenv("AGENT_SIZE_SETS", "5")
    monkeypatch.setenv("AGENT_DRY_RUN", "false")
    monkeypatch.setenv("ARC_CHAIN_ID", "5042002")
    cfg = AgentConfig.from_env()
    assert cfg.market_id == 7
    assert cfg.size_sets == 5
    assert cfg.dry_run is False
    assert cfg.chain_id == 5042002


def test_dry_run_defaults_on(monkeypatch):
    monkeypatch.setenv("AGENT_MARKET_ID", "1")
    monkeypatch.delenv("AGENT_DRY_RUN", raising=False)
    assert AgentConfig.from_env().dry_run is True


def test_uses_server_wallet(monkeypatch):
    cfg = AgentConfig(market_id=1, dynamic_api_key="k", dynamic_environment_id="e")
    assert cfg.uses_server_wallet() is True
    assert AgentConfig(market_id=1, agent_private_key="0xabc").uses_server_wallet() is False


# ---- price feed -------------------------------------------------------------
def _feed_with(handler) -> PriceFeed:
    transport = httpx.MockTransport(handler)
    return PriceFeed("https://api.example/api/v1",
                     client=httpx.Client(transport=transport))


def test_fetch_ok():
    def handler(request):
        assert request.url.path == "/api/v1/markets/public/42/price"
        return httpx.Response(200, json={"market_id": 42, "price_yes": 6200, "as_of": 99})

    q = _feed_with(handler).fetch(42)
    assert q.price_yes == 6200 and q.as_of == 99 and q.market_id == 42


def test_fetch_404_is_market_not_open():
    feed = _feed_with(lambda r: httpx.Response(404))
    with pytest.raises(MarketNotOpen):
        feed.fetch(42)


def test_fetch_500_is_unavailable():
    feed = _feed_with(lambda r: httpx.Response(500))
    with pytest.raises(PriceUnavailable):
        feed.fetch(42)


def test_fetch_out_of_range_rejected():
    feed = _feed_with(lambda r: httpx.Response(200, json={"price_yes": 0, "as_of": 1}))
    with pytest.raises(PriceUnavailable):
        feed.fetch(42)


def test_fetch_malformed_body():
    feed = _feed_with(lambda r: httpx.Response(200, json={"nope": 1}))
    with pytest.raises(PriceUnavailable):
        feed.fetch(42)
