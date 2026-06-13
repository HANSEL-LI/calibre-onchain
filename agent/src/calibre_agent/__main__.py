"""``python -m calibre_agent`` — boot the standalone market-maker agent.

Reads :class:`AgentConfig` from the environment, wires the public price feed +
the Arc contract client + the signer (Dynamic server wallet if configured, else
the local-key fallback), and runs the unattended loop. Config lives in env /
``.env``; this repo ships only ``.env.example`` placeholders.
"""
from __future__ import annotations

import logging
import sys

from .config import AgentConfig
from .contract import MarketClient
from .loop import run
from .price import PriceFeed
from .signer import build_signer


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("calibre_agent")

    try:
        config = AgentConfig.from_env()
    except ValueError as exc:
        log.error("config error: %s", exc)
        return 2

    if not config.contract_address:
        log.error("CALIBRE_MARKET_ADDRESS is not set — no contract to act on")
        return 2

    try:
        signer = build_signer(config)
    except ValueError as exc:
        log.error("signer error: %s", exc)
        return 2

    feed = PriceFeed(config.public_api_base)
    client = MarketClient(
        rpc_url=config.rpc_url,
        chain_id=config.chain_id,
        contract_address=config.contract_address,
        signer=signer,
        usdc_address=config.usdc_address,
    )
    log.info("signer=%s server_wallet=%s",
             client.address, config.uses_server_wallet())
    try:
        run(config, feed, client)
    finally:
        feed.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
