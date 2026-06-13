"""Canonical ``gg.calibre.*`` ENS text-record key schema.

This module is the single source of truth for the text-record keys calibre
publishes over ENS. The private app writes these keys; the W6.2 gateway answers
``text(node, key)`` for them; the W6.4 Discord bot reads ``gg.calibre.rank``
back. Keeping the names here (rather than as scattered string literals) means
the three sides cannot silently drift.

These are *names only* — this lib never fetches a profile or touches a network.
"""

from __future__ import annotations

from typing import Final

# Reverse-DNS-style namespace for calibre's own records. Standard ENS keys
# (e.g. ``com.discord``, ``avatar``) keep their conventional names and are not
# owned by this schema.
NAMESPACE: Final[str] = "gg.calibre"

# The rank/tier record the Discord role-sync reads. Its value is one of the
# ladder tier names (see ``ladder.TIERS``).
RANK_KEY: Final[str] = "gg.calibre.rank"

# The recency-decayed Brier skill score the rank is bucketed from (informational
# record; the bot does not need it).
BRIER_KEY: Final[str] = "gg.calibre.brier"

# Lifetime return on deployed points (informational).
ROI_KEY: Final[str] = "gg.calibre.roi"

# Riot identity + clan membership (informational identity records).
RIOT_KEY: Final[str] = "gg.calibre.riot"
CLAN_KEY: Final[str] = "gg.calibre.clan"

# The full set of calibre-owned text-record keys, in publish order.
CALIBRE_TEXT_KEYS: Final[tuple[str, ...]] = (
    RANK_KEY,
    BRIER_KEY,
    ROI_KEY,
    RIOT_KEY,
    CLAN_KEY,
)
