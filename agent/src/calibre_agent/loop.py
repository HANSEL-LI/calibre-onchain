"""run() — the unattended agent loop.

Each tick: check the kill-switch, read the public prior (W7.1), read on-chain
state, decide (:func:`maker.decide`), and execute the action through the
``MarketClient`` (mint / redeem) unless ``dry_run`` is set. Bounded by the
inventory cap (a bug can never spend past ``inventory_cap_sets`` complete sets)
and, for demos, by ``max_iterations`` and the kill-switch file.

Logging is plain structured ``logging`` (this is a standalone open-source
artifact, not the private app — no calibre logging stack). Addresses are logged;
they are pseudonymous on-chain personas (#224 / Seam 4), not user identities.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Callable

from .config import AgentConfig
from .contract import MarketClient
from .maker import Action, ActionKind, decide
from .price import MarketNotOpen, PriceFeed, PriceUnavailable

log = logging.getLogger("calibre_agent")


def _kill_switched(path: str) -> bool:
    return bool(path) and os.path.exists(path)


def step(config: AgentConfig, feed: PriceFeed, client: MarketClient) -> Action:
    """Run one decide-and-act tick. Returns the chosen Action (already executed
    unless dry-run). Raises on price/chain errors so the loop can back off."""
    quote = feed.fetch(config.market_id)
    view = client.view(config.market_id)
    action = decide(config, quote.price_yes, view)

    if action.kind is ActionKind.HOLD:
        log.info("hold market=%s prior=%s reason=%s",
                 config.market_id, quote.price_yes, action.reason)
        return action

    if config.dry_run:
        log.info("DRY-RUN %s market=%s sets=%s reason=%s",
                 action.kind.value, config.market_id, action.sets, action.reason)
        return action

    if action.kind is ActionKind.MINT:
        approve_tx = client.ensure_allowance(action.sets)
        if approve_tx:
            log.info("approve usdc market=%s tx=%s", config.market_id, approve_tx)
        tx = client.mint(config.market_id, action.sets)
        log.info("mint market=%s sets=%s tx=%s reason=%s",
                 config.market_id, action.sets, tx, action.reason)
    elif action.kind is ActionKind.REDEEM:
        tx = client.redeem(config.market_id)
        log.info("redeem market=%s tx=%s reason=%s",
                 config.market_id, tx, action.reason)
    return action


def run(
    config: AgentConfig,
    feed: PriceFeed,
    client: MarketClient,
    *,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Run the agent until the kill-switch trips, ``max_iterations`` is hit, or
    the process is stopped. Returns the number of ticks executed.

    ``sleep`` is injectable so tests drive the loop without real waits.
    """
    log.info(
        "agent start market=%s signer=%s dry_run=%s cap=%s band=[%s,%s] poll=%ss",
        config.market_id, client.address, config.dry_run,
        config.inventory_cap_sets, config.band_lo_micro, config.band_hi_micro,
        config.poll_interval_s,
    )
    ticks = 0
    while True:
        if config.max_iterations and ticks >= config.max_iterations:
            log.info("agent stop reason=max_iterations ticks=%s", ticks)
            break
        if _kill_switched(config.kill_switch_file):
            log.warning("agent halt reason=kill_switch file=%s",
                        config.kill_switch_file)
            break
        try:
            step(config, feed, client)
        except MarketNotOpen as exc:
            log.warning("market not open; backing off: %s", exc)
        except PriceUnavailable as exc:
            log.warning("price unavailable; backing off: %s", exc)
        except Exception:  # never let one bad tick kill the unattended loop
            log.exception("tick failed; continuing")
        ticks += 1
        if config.max_iterations and ticks >= config.max_iterations:
            continue  # let the top-of-loop guard log + break without sleeping
        sleep(config.poll_interval_s)
    return ticks
