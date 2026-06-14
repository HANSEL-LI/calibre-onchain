# 580 — Discord auto-channels per upcoming match

Issue: HANSEL-LI/Calibre#580 (P2). Target repo: `calibre-onchain`
(`discord-bot/` TypeScript). Builds on the merged W6.4 role-sync bot (#431).
Reads calibre **match** data (public, no auth) for the first time; rank still
comes from ENS only.

## What we build

The bot auto-creates exactly one text channel per upcoming VLR match, posts a
pinned message with the market link + current odds, and archives/removes the
channel once the match leaves the upcoming window. All on the existing reconcile
timer, idempotent, rate-limit-aware.

1. **`discord-bot/src/config.ts`** — add `calibreApiBase` (`CALIBRE_API_BASE`,
   default `https://app.hicalibre.gg`). This is the bot's first calibre egress;
   it remains **public, no-auth** — the bot has no calibre session.

2. **`discord-bot/src/matches.ts`** (new) — the pure + fetch layer:
   - `fetchUpcomingMatches(base)` → `GET /api/v1/matches/upcoming` (public).
   - `fetchPublicMarkets(base)` → `GET /api/v1/markets/public/markets` (public).
   - `channelNameFor(match)` — deterministic, idempotent Discord channel name
     (`<teamA>-vs-<teamB>` slugified, suffixed with a short match-id hash so two
     same-team matchups don't collide and the name round-trips to the match).
   - `matchMarket(match, markets)` — join a match to its open market by team
     names (the only public join key — see Decisions), returning the market id +
     YES price for the pinned message.
   - `pinnedMessageFor(match, market, base)` — the pinned-message text (market
     link to `#markets` + current odds, or "market not open yet").
   - `reconcileChannels(desired, existing)` — pure diff: which channels to
     create, which managed channels to archive (match no longer upcoming).

3. **`discord-bot/src/bot.ts`** — wire it in:
   - On `ready` and on the existing reconcile interval, run a
     `reconcileMatchChannels()` step alongside `resyncAll()`.
   - Create channels under a managed category, post + pin the message on create,
     update the pin on later passes, archive (move to an archive category) when
     the match drops out of the upcoming list.
   - Managed-channel detection is by category membership + name prefix so we
     never touch human-created channels (mirrors the managed-role invariant).

## Decisions (rationale)

- **Public reads only — no `by-match/{id}`.** The issue named
  `GET /api/v1/markets/by-match/{id}`, but that route is **authed**
  (`Depends(get_current_session)`); the bot has no `calibre_sid` cookie, so it
  can't call it. The real public surface is `GET /api/v1/markets/public/markets`
  (the bounded open-markets listing) + `GET /api/v1/matches/upcoming`. We use
  those. Keeping the bot to no-auth reads is also the correct trust boundary —
  it mirrors the ENS-only egress discipline of the rank path.
- **Join by team names, not match_id.** `PublicMarketListItem` exposes
  `market_id`, `question`, `team1`, `team2`, `price_yes` — but **not**
  `match_id`. The only public key shared with `/matches/upcoming` is the team
  pair, so `matchMarket()` joins on normalized `{team1, team2}` (order-
  insensitive). A match with no open market yet still gets a channel; the pin
  says the market isn't open and links to `#markets`.
- **Channel name = slug + short id hash.** `<a>-vs-<b>` alone isn't unique
  (rematches, BO3/BO5 across stages). We append a 6-char hash of `match_id` so
  the name is deterministic (idempotent re-runs find the same channel) and
  collision-safe. Discord channel names are lowercased/limited to 100 chars —
  the slugger enforces `[a-z0-9-]`.
- **Archive, don't delete.** Success criteria allow either; archiving (move to
  an "calibre-archive" category) is the less destructive default and preserves
  discussion history. The match leaving `/matches/upcoming` (settled/started/
  expired) is the trigger.
- **Managed by category + prefix.** Like the managed-role set, the bot only ever
  touches channels it owns (in its managed category, name carries the match-id
  hash). Human channels are never archived.
- **SPA link target `#markets`.** The SPA has no per-market deep-link route
  (`renderMarkets` is a single `#markets` page); the pin links there rather than
  inventing a route that doesn't exist.

## Files touched

- `discord-bot/src/config.ts` — `calibreApiBase` + `CALIBRE_API_BASE`.
- `discord-bot/src/matches.ts` — new pure-helpers + fetch module.
- `discord-bot/src/bot.ts` — wire `reconcileMatchChannels` into ready + timer.
- `discord-bot/test/matches.test.ts` — new tests for the pure layer.
- `.env.example` (repo root) — document `CALIBRE_API_BASE` if present.

## Risks

- **Rate limits / channel churn (operational, flagged Y in the issue).** Channel
  create/archive is rate-limited by Discord. Mitigation: the diff only acts on
  the delta (new matches → create; departed → archive), idempotent per pass, and
  the reconcile interval is the existing 5-min loop. No per-tick recreate.
- **Live RPC / network** is not exercised in tests — the pure layer
  (name, join, diff, pin text) is fully unit-tested with fixtures; the Discord
  + HTTP I/O is thin and integration-only (mirrors the W6.4 split).

## Test command

```
cd /tmp/onchain-580/discord-bot && npm install && npm test
```

(`tsc --noEmit` typecheck + `node --test` over `test/**/*.test.ts`; streamed, no
`-q`/pipe.)
