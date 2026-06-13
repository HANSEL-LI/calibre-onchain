"""Unit tests for the pure tier bucketer."""
from __future__ import annotations

import math

from calibre_ranking import all_tiers, tier_for_percentile


def test_ladder_is_the_f5_seven_tiers_floor_to_top() -> None:
    assert all_tiers() == ["Static", "Hunch", "Read", "Edge", "Sharp", "Seer", "Oracle"]


def test_floor_and_apex_bounds() -> None:
    assert tier_for_percentile(0.0) == "Static"
    assert tier_for_percentile(1.0) == "Oracle"


def test_band_lower_bounds_are_inclusive() -> None:
    # Each cut point lands the percentile in that band, not the one below it.
    assert tier_for_percentile(0.40) == "Hunch"
    assert tier_for_percentile(0.60) == "Read"
    assert tier_for_percentile(0.75) == "Edge"
    assert tier_for_percentile(0.90) == "Sharp"
    assert tier_for_percentile(0.97) == "Seer"
    assert tier_for_percentile(0.995) == "Oracle"


def test_just_below_a_cut_point_stays_in_the_lower_band() -> None:
    assert tier_for_percentile(0.399) == "Static"
    assert tier_for_percentile(0.599) == "Hunch"
    assert tier_for_percentile(0.969) == "Sharp"
    assert tier_for_percentile(0.9949) == "Seer"


def test_apex_tiers_are_scarce() -> None:
    # The whole [0.90, 0.97) band is Sharp; Seer/Oracle are the top ~3% / ~0.5%.
    assert tier_for_percentile(0.95) == "Sharp"
    assert tier_for_percentile(0.98) == "Seer"
    assert tier_for_percentile(0.999) == "Oracle"


def test_monotonic_non_decreasing_across_the_range() -> None:
    order = {name: i for i, name in enumerate(all_tiers())}
    last = -1
    p = 0.0
    while p <= 1.0:
        rank = order[tier_for_percentile(p)]
        assert rank >= last, f"tier went backwards at p={p}"
        last = rank
        p += 0.001


def test_out_of_range_clamps_rather_than_raises() -> None:
    assert tier_for_percentile(-0.5) == "Static"
    assert tier_for_percentile(1.5) == "Oracle"


def test_nan_maps_to_floor_tier() -> None:
    assert tier_for_percentile(float("nan")) == "Static"
    assert tier_for_percentile(math.nan) == "Static"
