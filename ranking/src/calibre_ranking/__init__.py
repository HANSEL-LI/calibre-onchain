"""calibre_ranking — skill-percentile → tier bucketing + ``gg.calibre.*`` keys.

Pure, dependency-light library. Two responsibilities (W6.4 / #431):

- ``ladder`` — the seven-tier rank ladder (``Static → Hunch → Read → Edge →
  Sharp → Seer → Oracle``), percentile-bucketed over the recency-decayed Brier
  skill score, top tier scarce. The *real* bucketer #419's interim version is
  replaced by; imported directly by the private app so tiers are computed with
  the exact code judges can read.
- ``keys`` — the canonical ``gg.calibre.*`` ENS text-record key schema the
  private app writes, the W6.2 gateway answers, and the W6.4 Discord bot reads.

Touches no network, no database, no Discord.
"""

from __future__ import annotations

from .keys import (
    BRIER_KEY,
    CALIBRE_TEXT_KEYS,
    CLAN_KEY,
    NAMESPACE,
    RANK_KEY,
    RIOT_KEY,
    ROI_KEY,
)
from .ladder import (
    CUTPOINTS,
    TIERS,
    UNRANKED,
    bucket,
    tier_for_percentile,
)

__version__ = "0.1.0"

__all__ = [
    # ladder
    "TIERS",
    "UNRANKED",
    "CUTPOINTS",
    "tier_for_percentile",
    "bucket",
    # keys
    "NAMESPACE",
    "RANK_KEY",
    "BRIER_KEY",
    "ROI_KEY",
    "RIOT_KEY",
    "CLAN_KEY",
    "CALIBRE_TEXT_KEYS",
]
