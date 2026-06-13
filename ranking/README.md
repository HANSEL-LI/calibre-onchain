# calibre_ranking

Pure rank-bucketing library — maps a skill percentile to a tier — plus the
canonical `gg.calibre.*` ENS text-record key schema.

Imported directly by the private calibre app (so tiers are computed with the
exact bucketing code the judges can read) and used by the ENS gateway to map
profile fields to text records. **No network, no database, no Discord.** This is
the real bucketer that #419's interim in-module version is replaced by.

## The ladder

Seven named tiers, lowest → highest, percentile-bucketed over the
**recency-decayed Brier skill score** (`user_calibration_scores` in the private
app), with the top tier deliberately scarce:

```
Static → Hunch → Read → Edge → Sharp → Seer → Oracle
```

A user's tier is a function of their **percentile** among scored peers, not
their absolute score — so the tier distribution is stable as the score scale
drifts, and `Oracle` stays a scarce signal (top ~2%).

| Tier | Percentile band |
|---|---|
| Static | `[0.00, 0.40)` |
| Hunch | `[0.40, 0.65)` |
| Read | `[0.65, 0.82)` |
| Edge | `[0.82, 0.92)` |
| Sharp | `[0.92, 0.975)` |
| Seer | `[0.975, 0.98)` |
| Oracle | `[0.98, 1.00]` |

## API

```python
import calibre_ranking as cr

# Cohort → tiers (None score → "Unranked", excluded from the percentile base).
cr.bucket({"alice": 0.31, "bob": 0.05, "carol": None})
# {"alice": "Sharp", "bob": "Static", "carol": "Unranked"}  (illustrative)

# A single percentile → tier.
cr.tier_for_percentile(0.99)  # "Oracle"

# Canonical ENS text-record keys the rank is published under.
cr.RANK_KEY           # "gg.calibre.rank"
cr.CALIBRE_TEXT_KEYS  # ("gg.calibre.rank", "gg.calibre.brier", ...)
```

The value of `gg.calibre.rank` is one of the ladder tier names above; the W6.4
Discord bot reads that record back over ENS and maps the tier to a server role.

## Tests

```
pip install -e ".[test]"
python -m pytest tests/
```
