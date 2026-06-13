"""The calibre rank ladder — percentile bucketing over a skill score.

The ladder is computed over the **recency-decayed Brier skill score**
(``user_calibration_scores`` in the private app: ``brier_skill = 1 −
brier_avg/0.25``, higher = better). This module knows nothing about how the
score is produced — it takes scores in and returns tiers. It is the *real*
bucketer that #419's interim in-module version is replaced by, and it is
imported directly by the private app so tiers are computed with the exact,
judge-readable code that ends up in the ``gg.calibre.rank`` ENS text record.

The mechanic is locked (overview F5): seven named tiers, percentile-bucketed,
with the top tier deliberately scarce.

    Static → Hunch → Read → Edge → Sharp → Seer → Oracle

A user's tier is a function of their **percentile** among scored peers — i.e.
the fraction of peers they rank at-or-above — not of their absolute score, so
the distribution of tiers is stable as the score scale drifts and the top tier
stays scarce by construction.
"""

from __future__ import annotations

from typing import Final, Mapping

# The seven tiers, lowest → highest. Index in this tuple is the tier's ordinal
# rank (0 = Static, 6 = Oracle). The names are the canonical ``gg.calibre.rank``
# values the Discord bot maps to roles.
TIERS: Final[tuple[str, ...]] = (
    "Static",
    "Hunch",
    "Read",
    "Edge",
    "Sharp",
    "Seer",
    "Oracle",
)

# The tier assigned to a user with no scored record yet. Distinct from any
# ladder tier; the bot treats it as "no role".
UNRANKED: Final[str] = "Unranked"

# Upper percentile bound (exclusive) for each tier except the top. A percentile
# ``p ∈ [0, 1]`` (fraction of peers at-or-below the user) falls in the first
# tier whose cutpoint it is strictly below; anything at/above the last cutpoint
# is the top tier. Cutpoints are ascending and the top band is the narrowest so
# ``Oracle`` stays scarce (top ~2%).
#
#   Static  [0.00, 0.40)   broad floor — most users
#   Hunch   [0.40, 0.65)
#   Read    [0.65, 0.82)
#   Edge    [0.82, 0.92)
#   Sharp   [0.92, 0.975)
#   Seer    [0.975, 0.98)  thin
#   Oracle  [0.98, 1.00]   top ~2% — scarce
#
# len(CUTPOINTS) == len(TIERS) - 1: each cutpoint closes one tier and opens the
# next; the final tier has no upper bound.
CUTPOINTS: Final[tuple[float, ...]] = (0.40, 0.65, 0.82, 0.92, 0.975, 0.98)

assert len(CUTPOINTS) == len(TIERS) - 1, "one cutpoint per tier boundary"
assert list(CUTPOINTS) == sorted(CUTPOINTS), "cutpoints must be ascending"


def tier_for_percentile(percentile: float) -> str:
    """Map a percentile ``∈ [0, 1]`` to a ladder tier.

    ``percentile`` is the fraction of scored peers the user ranks at-or-above
    (1.0 = best in the cohort, 0.0 = worst). Out-of-range inputs are clamped.
    """
    p = 0.0 if percentile < 0.0 else 1.0 if percentile > 1.0 else percentile
    for i, cut in enumerate(CUTPOINTS):
        if p < cut:
            return TIERS[i]
    return TIERS[-1]


def bucket(scores: Mapping[str, float | None]) -> dict[str, str]:
    """Bucket a cohort of users into ladder tiers by skill percentile.

    ``scores`` maps ``user_id`` → recency-decayed Brier skill score (or
    ``None`` for users with no scored record). Returns ``user_id`` → tier name.

    Percentile is computed with **fractional (average) ranking**: ties share the
    mean of the ranks they span, so equal scores get the same tier. A user's
    percentile is ``(count strictly below + 0.5·count equal) / N`` — the
    fraction of peers they rank at-or-above, mid-pointed for ties — which puts a
    lone user at 0.5 (mid-pack, not artificially top tier) and keeps the top
    band scarce. Users with a ``None`` score are ``UNRANKED`` and are excluded
    from the denominator so they don't dilute the percentile scale.
    """
    ranked: dict[str, str] = {}

    scored = {uid: s for uid, s in scores.items() if s is not None}
    for uid in scores:
        if uid not in scored:
            ranked[uid] = UNRANKED

    n = len(scored)
    if n == 0:
        return ranked

    values = list(scored.values())
    for uid, s in scored.items():
        below = sum(1 for v in values if v < s)
        equal = sum(1 for v in values if v == s)
        percentile = (below + 0.5 * equal) / n
        ranked[uid] = tier_for_percentile(percentile)

    return ranked
