# #596 — gateway: ENS-standard `avatar` / `url` / `description` records

The calibre Seam 2 profile now carries derived `avatar` / `url` / `description`
strings (sibling calibre PR). Map them to the **ENS-standard** text records so
generic ENS clients (wallets, etherscan, the ENS app) render a profile card for
`<display_name>.hicalibre.eth`.

These are ENS-standard global keys (`avatar`, `url`, `description`) — NOT
`gg.calibre.*` — so generic clients recognise them, exactly as `com.discord` is
reused rather than re-namespaced.

## Scope (parsimony)

Add the three keys to the canonical schema (`ranking/src/calibre_ranking/keys.py`
+ regenerate `ranking/keys.json`), the gateway map (`gateway/src/profile.ts`
`PublicProfile` + `TEXT_RECORD_KEYS`), and the schema tests. Do **not** touch
`gg.calibre.*` stats fields (#597's lane) or the clan namespace. `resolver.ts`
needs no change — it already dispatches any `text(key)` through `TEXT_RECORD_KEYS`.

## Files to touch

- `ranking/src/calibre_ranking/keys.py` — add `AVATAR_KEY = "avatar"`,
  `URL_KEY = "url"`, `DESCRIPTION_KEY = "description"`; add them to `TEXT_KEYS`.
- `ranking/src/calibre_ranking/__init__.py` — re-export the three new constants.
- `ranking/keys.json` — regenerate via `scripts/emit_keys_json.py` (the committed
  cross-language fixture; `test_keys_fixture.py` guards it byte-for-byte).
- `ranking/tests/test_keys.py` — extend the exact-set assertion + the
  namespace-exclusion set (these three are ENS-standard, like `com.discord`).
- `gateway/src/profile.ts` — add `avatar` / `url` / `description: string` to
  `PublicProfile`, and three readers to `TEXT_RECORD_KEYS`. They are always-present
  strings, so the readers return the field directly (no null→"" coalesce needed,
  but stay null-safe via `?? ""` for forward-compat with an unset value).

## Parity loop (#445 / #553)

`keys.py` → `emit_keys_json.py` → `keys.json` (pytest guards no drift) → the
gateway's `keys-schema.test.ts` asserts `TEXT_RECORD_KEYS` keys == `keys.json`
`text_keys`. Adding the three keys on both sides keeps the loop green; omitting
either side fails a test.

## Named commit phases

1. `docs(plan)`: this plan.
2. `feat(ranking)`: keys.py + __init__ re-export + regenerated keys.json + tests.
3. `feat(gateway)`: profile.ts PublicProfile + TEXT_RECORD_KEYS readers.

## Decisions

- **ENS-standard keys (`avatar`/`url`/`description`), not `gg.calibre.*`.** The
  whole point (issue goal) is that third-party UIs render them for free; that only
  works with the standard global keys. Same rationale as `com.discord`.
- **Source the gateway records from the calibre-derived fields**, not recomputed
  in TS. calibre owns the URL/description shape (it knows the public base + tier
  string); the gateway is a thin mapper, matching every existing reader.
- **Null-safe readers (`?? ""`)** even though calibre always sends a string — keeps
  the unset→"" (no-record) semantics uniform with the other text readers and
  robust if calibre ever returns null.

## Risks

- Parity drift if `keys.json` isn't regenerated — mitigated: `test_keys_fixture.py`
  fails byte-for-byte, and `keys-schema.test.ts` fails on the gateway side.

## Test command

```
cd /tmp/onchain-596/gateway && npm install && npm test
# and the ranking parity guard:
cd /tmp/onchain-596/ranking && python -m pytest tests/
```
