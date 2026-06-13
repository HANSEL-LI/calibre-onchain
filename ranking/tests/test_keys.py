"""Tests for the canonical ``gg.calibre.*`` key schema."""

from __future__ import annotations

import calibre_ranking as cr
from calibre_ranking import keys


def test_namespace_and_rank_key():
    assert keys.NAMESPACE == "gg.calibre"
    assert keys.RANK_KEY == "gg.calibre.rank"


def test_all_calibre_keys_are_namespaced_and_unique():
    assert len(set(keys.CALIBRE_TEXT_KEYS)) == len(keys.CALIBRE_TEXT_KEYS)
    for key in keys.CALIBRE_TEXT_KEYS:
        assert key.startswith(keys.NAMESPACE + ".")


def test_rank_key_is_published():
    assert keys.RANK_KEY in keys.CALIBRE_TEXT_KEYS


def test_reexported_from_package_root():
    assert cr.RANK_KEY == keys.RANK_KEY
    assert cr.CALIBRE_TEXT_KEYS == keys.CALIBRE_TEXT_KEYS
