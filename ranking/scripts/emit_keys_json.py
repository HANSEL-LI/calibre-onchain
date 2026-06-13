"""Emit the canonical text-record key set to ``ranking/keys.json``.

``keys.py`` is the single source of truth. The TypeScript ENS gateway can't import
that Python module, so this script renders the key set to a committed JSON fixture
the gateway reads — the cross-language seam. ``test_keys_fixture.py`` asserts the
committed fixture matches what this script would emit, so the JSON can't silently
drift from ``keys.py``.

Usage::

    python scripts/emit_keys_json.py          # rewrite ranking/keys.json
    python scripts/emit_keys_json.py --check   # exit 1 if the committed file is stale
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from calibre_ranking import TEXT_KEYS

# ranking/scripts/emit_keys_json.py -> ranking/keys.json
KEYS_JSON = Path(__file__).resolve().parent.parent / "keys.json"


def render() -> str:
    """The canonical JSON text for the committed fixture (sorted, trailing newline)."""
    return json.dumps({"text_keys": sorted(TEXT_KEYS)}, indent=2) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero if ranking/keys.json is out of date instead of rewriting it",
    )
    args = parser.parse_args(argv)

    rendered = render()
    if args.check:
        current = KEYS_JSON.read_text(encoding="utf-8") if KEYS_JSON.exists() else ""
        if current != rendered:
            print(
                f"{KEYS_JSON} is stale; run `python scripts/emit_keys_json.py`",
                file=sys.stderr,
            )
            return 1
        return 0

    KEYS_JSON.write_text(rendered, encoding="utf-8")
    print(f"wrote {KEYS_JSON}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
