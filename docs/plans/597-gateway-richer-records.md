# 597 — gateway: richer `gg.calibre.*` records (win-rate, resolved count, streak)

Refs HANSEL-LI/Calibre#597. The calibre-onchain half of #597: add the three new
`gg.calibre.*` user keys the private app's enriched `PublicProfileResponse` now
serves, keeping the cross-language drift guard (#445) green.

## Scope (parsimony)
- `ranking/src/calibre_ranking/keys.py` — three new named key constants +
  membership in `TEXT_KEYS`.
- `ranking/src/calibre_ranking/__init__.py` — export the new constants.
- `ranking/keys.json` — regenerated from `keys.py` via `scripts/emit_keys_json.py`.
- `ranking/tests/test_keys.py` — assert the new constants + namespace rules.
- `gateway/src/profile.ts` — add the three fields to `PublicProfile` + their
  readers in `TEXT_RECORD_KEYS` (null→`""` unset semantics).
- `gateway/test/profile.test.ts` — assert the new records map straight through +
  null→unset; the existing `keys-schema.test.ts` parity guard then covers the set.
- READMEs (`ranking/README.md`, `gateway/README.md`) — add the three rows to the
  key tables (route-shape doc kept in sync per the calibre invariant).

## New keys
| Constant | Key | Source field | Value |
|---|---|---|---|
| `WIN_RATE_KEY` | `gg.calibre.winrate` | `win_rate` | wins / settled markets (ratio); unset if no settled market |
| `RESOLVED_KEY` | `gg.calibre.resolved` | `n_resolved` | count of resolved (non-void) markets traded; unset if 0 |
| `STREAK_KEY` | `gg.calibre.streak` | `streak` | signed current run (+wins / −losses) over settled markets; unset if none |

All three are `gg.calibre.*`-namespaced (calibre-owned reputation stats), so they
ARE in the canonical user-key drift contract — added to `TEXT_KEYS`, `keys.json`,
and asserted by both the pytest fixture guard and `keys-schema.test.ts`.

## Decisions
- **`fmtNum` for all three numeric readers**, mirroring `brier`/`roi`: a null
  value → `""` (unset record), a present value stringified at full precision.
  `streak`/`n_resolved` are integers calibre-side; `String(n)` via `fmtNum`
  renders them without a decimal point.
- **`win_rate` / `streak` / `n_resolved` typed `number | null`** on
  `PublicProfile`, matching the calibre response (null when the user has no
  settled market), so the null→unset path is uniform with `brier_skill`/`roi`.
- These are per-user keys, NOT clan-aggregate keys — they go in
  `TEXT_RECORD_KEYS`, not `CLAN_TEXT_RECORD_KEYS`.

## Commit phases
1. `docs(plans): 597 gateway richer records plan` (this file).
2. `feat(ranking): winrate / resolved / streak gg.calibre.* keys + regen keys.json`.
3. `feat(gateway): map the three new stat records + README rows`.
4. `test: assert new keys (ranking) + new record mappings (gateway)`.

## Test command
```
cd /tmp/onchain-597/ranking && python -m pytest tests/
cd /tmp/onchain-597/gateway && npm install && npm test
```
