# calibre_ranking

Pure rank-bucketing library — maps a skill percentile to a tier — plus the
canonical `gg.calibre.*` ENS text-record key schema.

W0 scaffold — package skeleton only. Imported directly by the private calibre
app (so tiers are computed with the exact bucketing code the judges can read)
and used by the ENS gateway to map profile fields to text records.
Implementation lands with the ranking sub-issue.
