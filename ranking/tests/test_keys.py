"""Unit tests for the canonical gg.calibre.* key schema."""
from __future__ import annotations

from calibre_ranking import (
    AVATAR_KEY,
    BRIER_KEY,
    CLAN_KEY,
    DESCRIPTION_KEY,
    DISCORD_KEY,
    RANK_KEY,
    RIOT_KEY,
    ROI_KEY,
    TEXT_KEYS,
    URL_KEY,
)

# ENS-standard global record keys (not re-namespaced) — generic ENS clients
# render these for free, so they intentionally do NOT use the gg.calibre.* prefix.
_ENS_STANDARD_KEYS = {DISCORD_KEY, AVATAR_KEY, URL_KEY, DESCRIPTION_KEY}


def test_named_constants_have_the_expected_keys() -> None:
    assert RANK_KEY == "gg.calibre.rank"
    assert BRIER_KEY == "gg.calibre.brier"
    assert ROI_KEY == "gg.calibre.roi"
    assert CLAN_KEY == "gg.calibre.clan"
    assert RIOT_KEY == "gg.calibre.riot"
    assert DISCORD_KEY == "com.discord"
    assert AVATAR_KEY == "avatar"
    assert URL_KEY == "url"
    assert DESCRIPTION_KEY == "description"


def test_text_keys_is_exactly_the_named_constants() -> None:
    assert TEXT_KEYS == frozenset(
        {
            RANK_KEY,
            BRIER_KEY,
            ROI_KEY,
            CLAN_KEY,
            RIOT_KEY,
            DISCORD_KEY,
            AVATAR_KEY,
            URL_KEY,
            DESCRIPTION_KEY,
        }
    )


def test_text_keys_is_immutable() -> None:
    assert isinstance(TEXT_KEYS, frozenset)


def test_calibre_keys_use_the_gg_calibre_namespace() -> None:
    calibre_owned = TEXT_KEYS - _ENS_STANDARD_KEYS
    assert all(k.startswith("gg.calibre.") for k in calibre_owned)


def test_discord_uses_the_ens_standard_global_key() -> None:
    # com.discord, not a re-namespaced gg.calibre.discord — generic ENS clients
    # recognise the standard global key.
    assert DISCORD_KEY == "com.discord"
    assert DISCORD_KEY in TEXT_KEYS


def test_standard_profile_records_are_unprefixed() -> None:
    # #596: avatar / url / description are ENS-standard keys (no gg.calibre.*),
    # so generic wallets / the ENS app render a profile card for free.
    for key in (AVATAR_KEY, URL_KEY, DESCRIPTION_KEY):
        assert key in TEXT_KEYS
        assert not key.startswith("gg.calibre.")
