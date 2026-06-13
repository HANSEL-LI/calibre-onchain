# calibre_ranking

Pure, dependency-free library: maps a forecasting **skill percentile** to a named
**tier**, plus the canonical **`gg.calibre.*` ENS text-record key schema**.

Imported directly by the private calibre app (so tiers are computed with the
exact bucketing code the judges can read), by the ENS gateway tooling (so the
`gg.calibre.rank` record it serves matches), and by the Discord role-sync bot
(W6.4, so role assignment reads the same keys and tier names).

No DB, no scoring-pipeline coupling, no numpy. The composite-axis scoring that
*produces* the percentile (empirical-Bayes shrinkage + a lower-confidence-bound
sort over the recency-decayed Brier skill score) lives in calibre's
`leaderboard_scoring.py`; this lib only **buckets** the already-computed result.

## Tier ladder (F5)

Deliberately **not** Valorant's rank names — those are Riot IP and collide with a
user's real in-game rank. Seven tiers over a "higher = better" percentile
(`1.0` = top forecaster), scarcest last:

| Tier | Percentile band | Meaning |
|---|---|---|
| `Static` | `[0.00, 0.40)` | below median — hasn't beaten the field |
| `Hunch` | `[0.40, 0.60)` | around median |
| `Read` | `[0.60, 0.75)` | |
| `Edge` | `[0.75, 0.90)` | |
| `Sharp` | `[0.90, 0.97)` | top decile |
| `Seer` | `[0.97, 0.995)` | top ~3% |
| `Oracle` | `[0.995, 1.00]` | top ~0.5% — apex, scarce by design |

```python
from calibre_ranking import tier_for_percentile, all_tiers

tier_for_percentile(0.95)   # "Sharp"
tier_for_percentile(0.999)  # "Oracle"
all_tiers()                 # ["Static", "Hunch", "Read", "Edge", "Sharp", "Seer", "Oracle"]
```

`tier_for_percentile(p)` is **pure** and total: a percentile in `[0, 1]` maps to
the highest tier whose lower bound it clears; out-of-range inputs (float drift)
**clamp** and `NaN` maps to the floor tier — a resolver must never error on a
record read.

## Canonical `gg.calibre.*` key schema

The single source of truth for the ENS text-record keys every consumer answers.
`gg.calibre.*` is calibre's reverse-DNS namespace; `com.discord` is the
ENS-standard global key (reused so generic clients recognise it).

| Constant | Key | Value |
|---|---|---|
| `RANK_KEY` | `gg.calibre.rank` | named tier from `tier_for_percentile` |
| `BRIER_KEY` | `gg.calibre.brier` | Brier skill score (`1 − brier_avg/0.25`) |
| `ROI_KEY` | `gg.calibre.roi` | net / lifetime-deployed |
| `CLAN_KEY` | `gg.calibre.clan` | clan slug (the `<clan>` in `<user>.<clan>.calibre.eth`) |
| `RIOT_KEY` | `gg.calibre.riot` | Riot ID (RSO-verified where available) |
| `DISCORD_KEY` | `com.discord` | Discord handle (OAuth-verified) |

```python
from calibre_ranking import TEXT_KEYS, RANK_KEY
RANK_KEY in TEXT_KEYS  # True
```

The TypeScript gateway (`gateway/`) can't import this Python module, so it keeps
its own `TEXT_RECORD_KEYS` map; that map **mirrors this schema** — this module is
canonical and the gateway's README points here.

### Drift check (#445)

The two sides can't share a runtime import, so the schema is bridged by a
committed `keys.json` fixture generated from `keys.py`:

```sh
python scripts/emit_keys_json.py          # regenerate keys.json after a key change
python scripts/emit_keys_json.py --check  # CI-style staleness check
```

`tests/test_keys_fixture.py` asserts the committed `keys.json` matches `keys.py`
(so the fixture can't silently drift from the canonical set), and the gateway's
`test/keys-schema.test.ts` asserts its `TEXT_RECORD_KEYS` set-equals the same
fixture — closing the loop `keys.py → keys.json → TEXT_RECORD_KEYS`.

## Test

```sh
python -m pytest tests/
```
