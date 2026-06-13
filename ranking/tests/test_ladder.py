"""Tests for the rank-ladder bucketer."""

from __future__ import annotations

import calibre_ranking as cr
from calibre_ranking.ladder import CUTPOINTS, TIERS, UNRANKED, bucket, tier_for_percentile


def test_seven_named_tiers_in_order():
    assert TIERS == ("Static", "Hunch", "Read", "Edge", "Sharp", "Seer", "Oracle")


def test_one_cutpoint_per_boundary_ascending():
    assert len(CUTPOINTS) == len(TIERS) - 1
    assert list(CUTPOINTS) == sorted(CUTPOINTS)


def test_top_tier_is_scarce():
    # Oracle band is the narrowest — top ~2%.
    oracle_band = 1.0 - CUTPOINTS[-1]
    assert oracle_band <= 0.02 + 1e-9
    # ...and narrower than the floor (Static) band.
    static_band = CUTPOINTS[0]
    assert oracle_band < static_band


def test_percentile_endpoints():
    assert tier_for_percentile(0.0) == "Static"
    assert tier_for_percentile(1.0) == "Oracle"
    # Just below the top cutpoint is not yet Oracle.
    assert tier_for_percentile(CUTPOINTS[-1] - 1e-9) == "Seer"
    # Exactly at the top cutpoint is Oracle.
    assert tier_for_percentile(CUTPOINTS[-1]) == "Oracle"


def test_percentile_clamps_out_of_range():
    assert tier_for_percentile(-5.0) == "Static"
    assert tier_for_percentile(42.0) == "Oracle"


def test_each_band_lands_in_its_tier():
    # A representative percentile inside each band maps to that band's tier.
    edges = [0.0, *CUTPOINTS, 1.0]
    for i in range(len(TIERS)):
        lo, hi = edges[i], edges[i + 1]
        mid = (lo + hi) / 2
        assert tier_for_percentile(mid) == TIERS[i], (i, mid)


def test_bucket_orders_by_score():
    # 100 users with distinct ascending scores: the highest gets Oracle, the
    # lowest gets Static, and tiers are monotonic in score.
    scores = {f"u{i}": float(i) for i in range(100)}
    result = bucket(scores)
    assert result["u99"] == "Oracle"
    assert result["u0"] == "Static"
    # Monotonic: a higher score never yields a lower tier.
    order = {t: i for i, t in enumerate(TIERS)}
    by_score = sorted(scores, key=lambda u: scores[u])
    tier_ranks = [order[result[u]] for u in by_score]
    assert tier_ranks == sorted(tier_ranks)


def test_bucket_oracle_stays_scarce_in_a_large_cohort():
    scores = {f"u{i}": float(i) for i in range(1000)}
    result = bucket(scores)
    n_oracle = sum(1 for t in result.values() if t == "Oracle")
    assert 0 < n_oracle <= 25  # ~2% of 1000, generous ceiling


def test_bucket_ties_share_a_tier():
    # Everyone equal → everyone mid-pack (percentile 0.5) → same tier.
    scores = {f"u{i}": 1.0 for i in range(10)}
    result = bucket(scores)
    assert len(set(result.values())) == 1
    assert result["u0"] == tier_for_percentile(0.5)


def test_bucket_unranked_for_none_scores_and_excluded_from_denominator():
    # A None-scored user is Unranked and excluded from the percentile
    # denominator, so it never shifts the scored users' tiers. With the None
    # user counted (N=3) c would sit at (2+0.5)/3≈0.83; excluded (N=2) it sits
    # at (1+0.5)/2=0.75 — the latter is what we assert, proving exclusion.
    scores = {"a": None, "b": 1.0, "c": 2.0}
    result = bucket(scores)
    assert result["a"] == UNRANKED
    assert result["c"] == tier_for_percentile(0.75)
    assert result["b"] == tier_for_percentile(0.25)


def test_bucket_empty_and_all_none():
    assert bucket({}) == {}
    assert bucket({"a": None, "b": None}) == {"a": UNRANKED, "b": UNRANKED}


def test_lone_user_is_midpack_not_top():
    # A single scored user should not be crowned Oracle off one data point.
    result = bucket({"solo": 3.14})
    assert result["solo"] == tier_for_percentile(0.5)
    assert result["solo"] != "Oracle"


def test_public_api_reexports():
    assert cr.tier_for_percentile(1.0) == "Oracle"
    assert cr.bucket({"x": 1.0})["x"] == cr.tier_for_percentile(0.5)
