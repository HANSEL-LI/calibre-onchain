"""The canonical ``gg.calibre.*`` ENS text-record key schema.

Single source of truth for the record keys every consumer reuses. The ENS
gateway (``gateway/``, TypeScript) cannot import this Python module, so it keeps
its own ``TEXT_RECORD_KEYS`` map; both READMEs name this module as canonical so
the two stay in agreement. The Discord role-sync bot (W6.4) reads
``RANK_KEY`` / ``CLAN_KEY`` from here.

Keys follow the ENS convention of reverse-DNS namespacing. ``gg.calibre.*`` is
calibre's own namespace; ``com.discord`` is the ENS-standard global key for a
Discord handle (reused, not re-namespaced, so generic ENS clients recognise it).
"""
from __future__ import annotations

# calibre-owned, reverse-DNS-namespaced record keys.
RANK_KEY = "gg.calibre.rank"  # named tier from tier_for_percentile (e.g. "Sharp")
BRIER_KEY = "gg.calibre.brier"  # Brier skill score, 1 - brier_avg/0.25 (>0 beats a coin flip)
ROI_KEY = "gg.calibre.roi"  # net / lifetime-deployed
CLAN_KEY = "gg.calibre.clan"  # clan slug (the <clan> label in <user>.<clan>.calibre.eth)
RIOT_KEY = "gg.calibre.riot"  # Riot ID (RSO-verified where available)
# Forecasting-track stats (#597), derived calibre-side from the user's settled
# (resolved non-void) markets — the same set the app's win-rate summary uses.
WIN_RATE_KEY = "gg.calibre.winrate"  # wins / settled markets (ratio); unset until a market resolves
RESOLVED_KEY = "gg.calibre.resolved"  # count of resolved (non-void) markets traded; unset if 0
STREAK_KEY = "gg.calibre.streak"  # signed current run, +wins/-losses, most-recent-first; unset if none

# ENS-standard global keys (not re-namespaced) so generic clients recognise them.
DISCORD_KEY = "com.discord"  # Discord handle (OAuth-verified)
# Standard ENS profile records (#596): a wallet / etherscan / the ENS app render
# these for free, which is the whole point of mapping them. Derived calibre-side
# from display_name + tier (no per-user storage).
AVATAR_KEY = "avatar"  # https URL of the rank-coloured generated avatar SVG
URL_KEY = "url"  # the user's public calibre profile link
DESCRIPTION_KEY = "description"  # short derived one-liner ("Calibre forecaster — {tier}")

# The canonical set the gateway is expected to answer. Frozen so a consumer can
# membership-test without mutating it.
TEXT_KEYS: frozenset[str] = frozenset(
    {
        RANK_KEY,
        BRIER_KEY,
        ROI_KEY,
        CLAN_KEY,
        RIOT_KEY,
        WIN_RATE_KEY,
        RESOLVED_KEY,
        STREAK_KEY,
        DISCORD_KEY,
        AVATAR_KEY,
        URL_KEY,
        DESCRIPTION_KEY,
    }
)
