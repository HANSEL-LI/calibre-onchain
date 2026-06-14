# 595 — bare `<clan>.hicalibre.eth` clan-aggregate records (completion of #583)

`calibre-onchain` gateway issue `HANSEL-LI/Calibre#595`. Completes #583.

## Starting state (read before building — parsimony §7)

PR #27 (the gateway half of #583) **already shipped the entire bare-clan
serving path** on `main`:

- `resolver.ts`: `bareClanLabelFor(name)` (3-label clan candidate), and the
  clan-fallback branch in `handleResolve` — a bare `<clan>.hicalibre.eth` with no
  matching user, queried for a `gg.calibre.clan.*` key, resolves the clan profile.
  The stale "no clan-aggregate profile endpoint in Seam 2 this weekend" docstring
  the issue cites **is already corrected** (the `displayNameFor`/`bareClanLabelFor`
  docstrings now describe user-first disambiguation).
- `profile.ts`: `ClanProfile`, `ClanClient` + `createClanClient` (HTTP client for
  `GET /clans/{clan}`), `CLAN_TEXT_RECORD_KEYS`, `clanTextRecord`,
  `isClanRecordKey`.
- `index.ts`: `createClanClient` is wired into the resolve handler.
- 8 clan tests in `test/resolver.test.ts` + clan-key tests in `test/profile.test.ts`,
  all green (27/27 on `main`).

The `ClanProfile` interface already matches calibre's `ClanProfileResponse`
(`clan, size, avg_rank, brier_skill, median_brier_skill, roi, top_member`) field
for field.

So the issue's literal premise (`displayNameFor` returns null / docstring stale /
nothing wired) is **already resolved by #27**. Re-implementing any of it would
violate parsimony.

## The one genuine residual gap

#595's success criteria + Approach name the clan record set as
`rank, brier, roi, size, **top** (top_member)`. The merged `CLAN_TEXT_RECORD_KEYS`
serves `size, avgrank, brier, roi` but **not** the `top_member` field — and
`median_brier_skill`, already fetched into `ClanProfile`, is likewise unexposed.

The minimal completion is therefore to expose the two clan-card fields that are
fetched-but-unserved as records:

- `gg.calibre.clan.top`    → `top_member` (highest-skill member's display_name)
- `gg.calibre.clan.median` → `median_brier_skill`

Naming: keep the existing `gg.calibre.clan.avgrank` (already shipped, more precise
than the issue's shorthand `rank`); do **not** churn shipped keys. `top` is a
display_name string (empty when no member is scored — same null→"" semantics as
the existing keys, no oracle). `median` reuses the `fmtNum` null→"" formatter like
`brier`/`roi`.

## Scope (parsimony)
- `gateway/src/profile.ts`: add two entries to `CLAN_TEXT_RECORD_KEYS`
  (`gg.calibre.clan.top`, `gg.calibre.clan.median`). No new types, clients, or
  resolver branches — the existing `isClanRecordKey` + clan-fallback branch picks
  them up automatically.
- `gateway/test/profile.test.ts` + `gateway/test/resolver.test.ts`: extend the
  existing clan tests to cover `top`/`median` mapping (incl. null → empty) and
  end-to-end resolve of `top` on a bare clan name.
- `gateway/README.md`: add the two rows to the clan record-key table.

Out of scope (unchanged from #583's deferral): promoting clan keys into the
canonical `ranking/` lib + `keys.json` drift contract. The clan keys describe a
clan, not a user; `test/keys-schema.test.ts` pins only the per-user
`TEXT_RECORD_KEYS`. No calibre-side change (`/clans/{clan}` already returns
`top_member`/`median_brier_skill`).

## Files touched
- `gateway/src/profile.ts`
- `gateway/test/profile.test.ts`, `gateway/test/resolver.test.ts`
- `gateway/README.md`

## Commit phases
1. `docs(plans)`: this plan.
2. `feat(gateway)`: add `gg.calibre.clan.top` + `gg.calibre.clan.median` to
   `CLAN_TEXT_RECORD_KEYS`.
3. `test(gateway)`: extend clan key + resolve coverage.
4. `docs(gateway)`: README clan record-key table rows.

## Tests
`cd gateway && npm install && npm test`
