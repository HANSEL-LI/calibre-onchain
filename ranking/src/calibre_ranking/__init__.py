"""calibre_ranking — skill-percentile -> tier bucketing + gg.calibre.* key schema.

Pure, dependency-free library imported by both the private calibre app (so tiers
are computed with the exact code the judges can read) and the ENS gateway tooling
/ Discord role-sync bot (so every consumer agrees on the tier names and the
canonical ``gg.calibre.*`` record keys).

- ``tier_for_percentile(p)`` / ``all_tiers()`` — the F5 tier ladder.
- ``TEXT_KEYS`` + the named ``*_KEY`` constants — the canonical record schema.
"""
from __future__ import annotations

from .keys import (
    AVATAR_KEY,
    BRIER_KEY,
    CLAN_KEY,
    DESCRIPTION_KEY,
    DISCORD_KEY,
    RANK_KEY,
    RESOLVED_KEY,
    RIOT_KEY,
    ROI_KEY,
    STREAK_KEY,
    TEXT_KEYS,
    URL_KEY,
    WIN_RATE_KEY,
)
from .tiers import all_tiers, tier_for_percentile

__version__ = "0.1.0"

__all__ = [
    "tier_for_percentile",
    "all_tiers",
    "TEXT_KEYS",
    "RANK_KEY",
    "BRIER_KEY",
    "ROI_KEY",
    "CLAN_KEY",
    "RIOT_KEY",
    "WIN_RATE_KEY",
    "RESOLVED_KEY",
    "STREAK_KEY",
    "DISCORD_KEY",
    "AVATAR_KEY",
    "URL_KEY",
    "DESCRIPTION_KEY",
]
