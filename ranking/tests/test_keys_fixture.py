"""The committed ``keys.json`` fixture must not drift from ``keys.py``.

``keys.json`` is the cross-language seam the TypeScript gateway reads (it can't
import the Python module). This guard regenerates the fixture in-memory from
``TEXT_KEYS`` and asserts the committed file matches, so a key added/renamed in
``keys.py`` without re-running the generator fails the ranking test run. The
gateway's own test then asserts ``TEXT_RECORD_KEYS`` equals this same fixture,
closing the loop.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from calibre_ranking import TEXT_KEYS

# ranking/tests/test_keys_fixture.py -> ranking/
RANKING_ROOT = Path(__file__).resolve().parent.parent
KEYS_JSON = RANKING_ROOT / "keys.json"

# Make scripts/ importable so the test exercises the real generator, not a copy.
sys.path.insert(0, str(RANKING_ROOT / "scripts"))
import emit_keys_json  # noqa: E402


def test_committed_fixture_matches_keys_py() -> None:
    # Byte-for-byte: the committed file equals what the generator emits today.
    assert KEYS_JSON.read_text(encoding="utf-8") == emit_keys_json.render(), (
        "ranking/keys.json is stale — run `python scripts/emit_keys_json.py`"
    )


def test_fixture_key_set_equals_text_keys() -> None:
    fixture = json.loads(KEYS_JSON.read_text(encoding="utf-8"))
    assert set(fixture["text_keys"]) == set(TEXT_KEYS)


def test_generator_check_mode_passes_for_committed_fixture() -> None:
    # --check is what a future CI step would run; it must agree with the commit.
    assert emit_keys_json.main(["--check"]) == 0
