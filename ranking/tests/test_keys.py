"""Unit tests for the canonical gg.calibre.* key schema."""
from __future__ import annotations

from calibre_ranking import (
    BRIER_KEY,
    CLAN_KEY,
    DISCORD_KEY,
    RANK_KEY,
    RIOT_KEY,
    ROI_KEY,
    TEXT_KEYS,
)


def test_named_constants_have_the_expected_keys() -> None:
    assert RANK_KEY == "gg.calibre.rank"
    assert BRIER_KEY == "gg.calibre.brier"
    assert ROI_KEY == "gg.calibre.roi"
    assert CLAN_KEY == "gg.calibre.clan"
    assert RIOT_KEY == "gg.calibre.riot"
    assert DISCORD_KEY == "com.discord"


def test_text_keys_is_exactly_the_named_constants() -> None:
    assert TEXT_KEYS == frozenset(
        {RANK_KEY, BRIER_KEY, ROI_KEY, CLAN_KEY, RIOT_KEY, DISCORD_KEY}
    )


def test_text_keys_is_immutable() -> None:
    assert isinstance(TEXT_KEYS, frozenset)


def test_calibre_keys_use_the_gg_calibre_namespace() -> None:
    calibre_owned = TEXT_KEYS - {DISCORD_KEY}
    assert all(k.startswith("gg.calibre.") for k in calibre_owned)


def test_discord_uses_the_ens_standard_global_key() -> None:
    # com.discord, not a re-namespaced gg.calibre.discord — generic ENS clients
    # recognise the standard global key.
    assert DISCORD_KEY == "com.discord"
    assert DISCORD_KEY in TEXT_KEYS
