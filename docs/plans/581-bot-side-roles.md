# 581 — Discord "Backing <Team>" side roles (calibre-onchain bot)

## Issue
For the NEXT upcoming match's market, the Discord bot reads calibre's
service-authed `GET /api/v1/markets/{id}/sides` (predominant side per public
holder), maps each calibre `display_name` back to a linked Discord member (via
the #582 identity registry), and assigns a public `Backing <TeamA>` /
`Backing <TeamB>` role — created on demand in a team colour. Roles cleared at
lock/settle; only one match active at a time. Refs HANSEL-LI/Calibre#581.

## Privacy note
This INTENTIONALLY reveals each member's market position publicly — the
deliberate opposite of the rank-role privacy invariant (`roles.ts`).
Owner-approved in #581 as a public social mechanic. Built as specified.

## Architecture (rides #580 + #582)
- #580 already pulls calibre's PUBLIC `/matches/upcoming` + `/markets/public/markets`
  and joins match↔market by team pair (`matches.ts`). Side roles reuse that join
  to pick the single ACTIVE match.
- #582 owns the in-memory `discordId → ensName` registry (verified push). Side
  roles reverse it to `display_name → discordId` (the `/sides` join key).
- The `/sides` read is the FIRST authed calibre pull from the bot — it sends the
  `X-Calibre-Markets-Token` service header (`MARKETS_SERVICE_TOKEN`). Empty token
  ⇒ the whole feature is OFF (the calibre endpoint is fail-closed regardless).

## Files to touch
- `discord-bot/src/sides.ts` (new) — pure core: `backingRoleName`,
  `isBackingRoleName`, `teamColor` (deterministic per-team colour),
  `activeMatch` (pick the soonest upcoming match with a market),
  `displayNameToMemberId` (reverse the registry), `desiredSideAssignments`,
  `reconcileSideRoles` (per-member add/remove diff), + thin-IO `fetchSides`.
- `discord-bot/src/config.ts` — `marketsServiceToken` (opt-in, empty = off).
- `discord-bot/src/bot.ts` — `reconcileSideRolesPass`: pick active match → fetch
  `/sides` → ensure the two team roles → assign each linked holder, clear linked
  non-holders, clear ALL `Backing *` when the active match switches / none. Wired
  into the boot `ready` handler + the periodic resync interval.
- `.env.example` — `MARKETS_SERVICE_TOKEN=`.
- `discord-bot/test/sides.test.ts` (new) — pure-core unit tests.

## Named commit phases
1. plan (this file).
2. `sides.ts` pure core + `fetchSides` + config var + `.env.example`.
3. `bot.ts` wiring (ensure roles, clear, reconcile pass, loop hookup).
4. tests.

## Decisions
- **Only-one-match-active enforced via a tracked `activeSideMarketId`.** When the
  soonest-upcoming-with-a-market changes (or none qualifies), strip every
  `Backing *` role before applying the new match's — so a settled/locked match's
  roles always clear (it drops out of `/matches/upcoming`). (decision)
- **Active match = soonest upcoming with an OPEN market** (reuses #580's
  `matchMarket` team-pair join). A match with no open market gets no side roles
  (nothing to read sides from); it still gets a #580 channel. (decision)
- **Per-team colour is deterministic** (FNV-1a → HSL mid-band), so a team keeps
  its colour across matches with zero palette config — matches the bot's existing
  "created on demand, no manual setup" ethos. (decision)
- **Token presence is the feature gate** (mirrors `IDENTITY_WEBHOOK_SECRET`):
  empty ⇒ side-role sync off, rank roles + match channels unaffected. (decision)
- **Holders joined by `display_name` leftmost-label**, lowercased, against the
  reversed registry — the only key calibre exposes and the bot already holds.
  Linked non-holders are stripped (they closed their position). (decision)
- **Errors isolated per pass + per member** — the side-role pass never stalls the
  rank loop or the channel loop (same resilience contract as #580). (decision)

## Risks
- Reads a NEW authed calibre surface — gated by an opt-in token; fail-closed
  calibre-side. No writes to calibre.
- Privacy: intentional public exposure (owner-approved). Bounded to the public
  display name + which side; no money, no calibre user_id.

## Test command
`cd discord-bot && npm install && npm test`
