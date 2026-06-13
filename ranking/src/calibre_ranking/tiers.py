"""Tier ladder + the pure percentile -> tier bucketer.

The ladder is the ETHGlobal F5 ranking: deliberately *not* Valorant's rank names
(Riot IP + it collides with a user's real in-game rank). Seven tiers, scarcest
last, over a "higher = better" skill percentile (1.0 = top forecaster), matching
calibre's Brier-skill-score orientation.

Pure + dependency-free: this lib buckets an *already-computed* percentile and
carries no DB / scoring-pipeline coupling. The composite-axis scoring that
*produces* the percentile (empirical-Bayes shrinkage + lower-confidence bound)
stays in calibre's ``leaderboard_scoring.py``; this module only maps the result
to a name both the gateway and the Discord role-sync bot (W6.4) reuse.
"""
from __future__ import annotations

# Ordered floor -> top. The cut points are the *lower* percentile bound of each
# tier; a percentile p lands in the highest tier whose lower bound it clears.
# The top two bands (Seer, Oracle) are narrow on purpose — the apex stays scarce.
#
#   Static :  [0.00, 0.40)   below-median: hasn't beaten the field
#   Hunch  :  [0.40, 0.60)   around median
#   Read   :  [0.60, 0.75)
#   Edge   :  [0.75, 0.90)
#   Sharp  :  [0.90, 0.97)
#   Seer   :  [0.97, 0.995)   top ~3%
#   Oracle :  [0.995, 1.00]   top ~0.5%
_LADDER: tuple[tuple[float, str], ...] = (
    (0.0, "Static"),
    (0.40, "Hunch"),
    (0.60, "Read"),
    (0.75, "Edge"),
    (0.90, "Sharp"),
    (0.97, "Seer"),
    (0.995, "Oracle"),
)


def all_tiers() -> list[str]:
    """The tier names floor -> top (scarcest last). Consumers (e.g. the Discord
    role-sync bot, W6.4) enumerate the ladder from here instead of re-listing it."""
    return [name for _, name in _LADDER]


def tier_for_percentile(p: float) -> str:
    """Pure. Skill percentile in ``[0, 1]`` (higher = better) -> named tier.

    Canonical bucketer for every consumer — the value the gateway serves as
    ``text('gg.calibre.rank')`` and the bot reads to assign a Discord role.

    Out-of-range inputs **clamp** rather than raise: a resolver must never error
    on a record read, and a percentile is mathematically bounded anyway, so a
    stray ``1.0001`` (float drift) maps to the top tier, a negative to the floor.
    """
    if p != p:  # NaN guard — an unscored/degenerate input is the floor tier.
        return _LADDER[0][1]
    if p <= 0.0:
        return _LADDER[0][1]
    if p >= 1.0:
        return _LADDER[-1][1]
    tier = _LADDER[0][1]
    for lower, name in _LADDER:
        if p >= lower:
            tier = name
        else:
            break
    return tier
