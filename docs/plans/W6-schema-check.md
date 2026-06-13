# W6 — Python↔TS key-schema drift check (#445)

Follow-up from onchain#8 (W6.3). The canonical `gg.calibre.*` (+ `com.discord`)
ENS text-record key set lives in two places that agree today but are coupled only
by prose in two READMEs:

- **Canonical**: `ranking/src/calibre_ranking/keys.py` — `TEXT_KEYS` frozenset +
  named `*_KEY` constants.
- **Served**: `gateway/src/profile.ts` — `TEXT_RECORD_KEYS` map.

A TypeScript service can't import the Python module, so nothing fails today if one
side gains/renames a key and the other isn't updated. This adds a programmatic
equality check so a future drift fails the build.

## Approach (per #445's proposed fix)

The two languages can't share a runtime import, so the shared boundary is a
committed JSON fixture that both sides reference:

1. **`ranking/scripts/emit_keys_json.py`** — tiny generator that writes the sorted
   `TEXT_KEYS` set to `ranking/keys.json` (`{"text_keys": [...]}`). Single source of
   truth stays `keys.py`; the JSON is a derived, committed artifact.
2. **`ranking/keys.json`** — committed fixture (the cross-language contract).
3. **Ranking-side guard** (`ranking/tests/test_keys_fixture.py`): regenerate the
   fixture in-memory and assert the committed `keys.json` matches `keys.py`, so the
   fixture can't silently drift from the canonical Python set.
4. **Gateway-side guard** (`gateway/test/keys-schema.test.ts`): import the committed
   `keys.json` and assert `Object.keys(TEXT_RECORD_KEYS)` set-equals the fixture set.
   Wired into the existing `npm test` (`node --test`).

This gives a closed loop: `keys.py` → (generator, guarded by ranking test) →
`keys.json` → (gateway test) → `TEXT_RECORD_KEYS`. Any divergence at either hop
fails a test.

## Files to touch
- `ranking/scripts/emit_keys_json.py` (new) — generator.
- `ranking/keys.json` (new) — committed fixture.
- `ranking/tests/test_keys_fixture.py` (new) — fixture-matches-keys.py guard.
- `gateway/test/keys-schema.test.ts` (new) — `TEXT_RECORD_KEYS` ⇔ fixture guard.
- `ranking/README.md`, `gateway/README.md` — note the drift check (the prose
  contract now has teeth).

## Named commit phases
1. `plan` — this file.
2. `feat(ranking)` — generator script + committed `keys.json` + ranking guard test.
3. `test(gateway)` — gateway `node:test` asserting `TEXT_RECORD_KEYS` ⇔ fixture.
4. `docs` — README notes on both sides.

## Decisions
- **JSON fixture as the seam, not a codegen of the TS map.** Codegenerating the TS
  `TEXT_RECORD_KEYS` map from Python would couple build order and lose the
  hand-written field readers; a JSON key-set fixture is the minimal shared artifact
  both runtimes can read. (Matches #445's proposal verbatim.)
- **Two guards, not one.** The ranking guard stops `keys.json` drifting from
  `keys.py`; the gateway guard stops `TEXT_RECORD_KEYS` drifting from `keys.json`.
  Either alone leaves a gap.
- **Set-equality on keys only** — `TEXT_RECORD_KEYS` values are field readers
  (gateway-specific) and are intentionally not part of the contract; only the key
  set is the shared schema.
- **No new CI workflow.** Per parsimony, the check rides the existing `npm test`
  and `pytest tests/` runs that already exist for each package; only `contracts.yml`
  is in GH Actions today and wiring a new workflow is out of scope for a p3.

## Risks
- Gateway runs `node --test --import tsx`; importing `../../ranking/keys.json`
  needs a relative path that resolves from the test file. Verified the repo layout
  (`gateway/` and `ranking/` are siblings).

## Test command
- Ranking: `cd ranking && PYTHONPATH=src /Users/hansel/docs/dev/calibre/.venv/bin/python -m pytest tests/`
- Gateway: `cd gateway && npm install && npm test`
