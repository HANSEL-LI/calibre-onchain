# 583 — Clan-aggregate ENS records (gateway half)

`calibre-onchain` half of `HANSEL-LI/Calibre#583`. Serves clan-aggregate text
records (`gg.calibre.clan.*`) on a bare `<clan>.hicalibre.eth`, consuming the new
calibre `GET /api/v1/clans/{clan}` endpoint (the calibre PR). Builds on #550
(clan-nested user resolution).

## Scope (parsimony)
- `gateway/src/profile.ts`: add a `ClanProfile` type + `ClanClient` (HTTP client
  for `/clans/{clan}`) + a clan-specific `CLAN_TEXT_RECORD_KEYS` map and helpers.
- `gateway/src/resolver.ts`: `bareClanLabelFor(name)` (3-label clan candidate);
  extend `handleResolve` to fall back to clan records for a bare clan name with
  no matching user.
- `gateway/src/index.ts`: wire a `createClanClient` into the handler.
- Tests + README "Name shapes" / record-key table update.

## Design decisions
- **User-first disambiguation.** A bare 3-label `<clan>.hicalibre.eth` is
  ambiguous (could be a user OR a clan). We fetch the leftmost label as a **user**
  first; only when no such user exists do we serve clan records. This satisfies
  the success criterion "a real user name still resolves as a user" without a
  config-time namespace split, and is the safe default if a user and a clan ever
  share a label.
- **Clan keys are a separate namespace from the user-key drift contract.**
  `CLAN_TEXT_RECORD_KEYS` (`gg.calibre.clan.{size,avgrank,brier,roi}`) is NOT
  added to `TEXT_RECORD_KEYS`, so `test/keys-schema.test.ts` (which pins the
  canonical user `gg.calibre.*` set against `ranking/keys.json`) is unchanged.
  The clan keys describe a clan profile, not a user, and the existing single
  `gg.calibre.clan` user key (a user's clan *label*) is distinct from these
  dotted aggregate keys — no collision. Promoting clan keys into the canonical
  `ranking/` lib is deferred (out of this PR's scope).
- **`addr()` is user-only.** A clan has no wallet; a clan-only name resolves
  `addr()` to the zero address (clan fallback only fires for clan `text()` keys).
- **`ClanClient` defaults to a null client** in `handleResolve` so existing
  2-arg call-sites/tests are unaffected; `index.ts` injects the real one.
- **Nested names stay user leaves.** `bareClanLabelFor` returns null for ≥4-label
  names, so `<user>.<clan>.hicalibre.eth` is never treated as a clan (matches
  #550 / W6.3).

## Files touched
- `gateway/src/profile.ts`, `gateway/src/resolver.ts`, `gateway/src/index.ts`
- `gateway/test/resolver.test.ts` (clan resolution + user-first cases)
- `gateway/test/profile.test.ts` (clan key mapping) — new
- `gateway/README.md` (name-shapes + record-key tables)

## Commit phases
1. `docs(plans)`: this plan.
2. `feat(gateway)`: `ClanProfile`/`ClanClient`/clan-key map + resolver fallback +
   index wiring.
3. `test`: clan resolution, user-first tie-break, clan-only addr → zero.
4. `docs(gateway)`: README tables.

## Tests
`cd gateway && npm install && npm test`
