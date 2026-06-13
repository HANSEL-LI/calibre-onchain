"""PriceFeed — the agent's only calibre input (Seam 4, W7.1).

Reads ``GET {base}/markets/public/{id}/price`` — a **public, unauthenticated**
endpoint that returns the live LMSR YES price for one open market. The agent
makes no authed calls and imports nothing from the private app; this HTTP read
is the entire calibre surface it touches (checkable from the public repo).

Response shape (W7.1 / calibre #420):

    { "market_id": int, "price_yes": int, "as_of": int }

- ``price_yes`` is in **micro-cents**, range ``[1, 9999]`` (``10000`` == prob 1).
- ``as_of`` is wall-clock unix seconds at read time.
- ``404`` for an unknown / locked / resolved / void market (uniform).
"""
from __future__ import annotations

from dataclasses import dataclass

import httpx


class MarketNotOpen(Exception):
    """Raised when the public endpoint 404s — market is unknown or not open."""


class PriceUnavailable(Exception):
    """Raised on any other non-200 or a malformed body."""


@dataclass(frozen=True)
class Quote:
    """A single read of the public prior."""

    market_id: int
    price_yes: int  # micro-cents, [1, 9999]
    as_of: int  # unix seconds


class PriceFeed:
    """Thin client over the W7.1 public price endpoint.

    A ``client`` may be injected for testing; otherwise one is created lazily
    with a short timeout. Never sends credentials.
    """

    def __init__(self, base_url: str, *, client: httpx.Client | None = None,
                 timeout: float = 10.0) -> None:
        self._base = base_url.rstrip("/")
        self._client = client
        self._owns_client = client is None
        self._timeout = timeout

    def _http(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self._timeout)
        return self._client

    def fetch(self, market_id: int) -> Quote:
        """Read the current YES prior for ``market_id``.

        Raises :class:`MarketNotOpen` on 404 and :class:`PriceUnavailable` on any
        other failure, so the loop can back off without acting on stale data.
        """
        url = f"{self._base}/markets/public/{market_id}/price"
        try:
            resp = self._http().get(url)
        except httpx.HTTPError as exc:  # network / DNS / timeout
            raise PriceUnavailable(f"price fetch failed: {exc}") from exc

        if resp.status_code == 404:
            raise MarketNotOpen(f"market {market_id} not open (404)")
        if resp.status_code != 200:
            raise PriceUnavailable(
                f"unexpected status {resp.status_code} from {url}"
            )

        try:
            body = resp.json()
            price = int(body["price_yes"])
            as_of = int(body["as_of"])
        except (ValueError, KeyError, TypeError) as exc:
            raise PriceUnavailable(f"malformed price body: {exc}") from exc

        if not (1 <= price <= 9999):
            raise PriceUnavailable(f"price_yes out of range: {price}")

        return Quote(market_id=int(body.get("market_id", market_id)),
                     price_yes=price, as_of=as_of)

    def close(self) -> None:
        if self._owns_client and self._client is not None:
            self._client.close()
            self._client = None
