# 582 — Bot identity ingest (calibre-onchain side)

Refs HANSEL-LI/Calibre#582. The calibre app now owns a verified
`discord_id ↔ account ↔ <name>.hicalibre.eth` mapping and PUSHES
`(discord_id ↔ display_name)` to this bot over a SIGNED webhook. This PR makes
the bot ingest that push instead of relying on the user-run `/link` map, and
removes the spoofable user `/link`.

Identity ≠ reputation: rank is STILL resolved from ENS on the timer
(`RankReader`). Only *identity* (which Discord member maps to which ENS name)
now arrives verified from calibre rather than being self-asserted via `/link`.

## Decisions

- **Signed ingest, byte-for-byte.** calibre signs `HMAC-SHA256(secret, body)`
  over the EXACT raw JSON body and sends `X-Calibre-Signature: sha256=<hex>`.
  The bot verifies over the raw bytes it received (not a re-serialization) with
  a constant-time compare. Body shape: `{"discord_id","display_name"}` (calibre
  emits canonical JSON: sorted keys, no spaces). A cross-boundary vector is
  pinned in the test (same vector as calibre `tests/test_accounts.py`).
- **Map `display_name → <display_name>.<ensParent>`** to reuse the existing
  `isAcceptedName` / `RankReader` resolution path unchanged. The registry value
  stays an ENS name, so `syncMember` / `resyncAll` are untouched.
- **`/link` removed, not admin-gated.** The issue offers "admin-only OR remove";
  removing it deletes the spoof surface entirely (the whole point) and is the
  smaller, cleaner change — there is no remaining legitimate user use for it
  now that identity is pushed. The slash-command registration is dropped.
- **HTTP ingest server** is a tiny Node `http` listener (no new dependency),
  started alongside the Discord client. On a verified push it updates the
  in-memory registry and immediately reconciles that one member's role.
- **Poll fallback is out of scope as a separate puller** — calibre pushes on
  connect, and the existing periodic `resyncAll` already re-resolves rank for
  every known member. The push + resync loop together cover the "identity
  arrives, role converges" requirement; a calibre-pull would re-introduce the
  bot→calibre coupling the issue explicitly removes.

## Files

- `discord-bot/src/identity.ts` (new) — `verifySignature(secret, rawBody, header)`,
  `parseIdentity(rawBody)`, and a `createIdentityServer(...)` http listener that
  verifies + applies the push.
- `discord-bot/src/config.ts` — add `identityWebhookSecret` + `identityPort`;
  drop nothing (keeps ENS vars).
- `discord-bot/src/bot.ts` — remove `/link` command + handler; expose a
  `linkMember(discordId, ensName)` the ingest server calls to update the
  registry + reconcile one member.
- `discord-bot/src/index.ts` — start the identity server next to the bot.
- `discord-bot/test/identity.test.ts` (new) — signature verify (good/tampered/
  wrong-secret), the pinned cross-boundary vector, name mapping, and reject of a
  malformed body.
- root `.env.example` + `discord-bot` package description — document the ingest
  vars; note the bot now ingests a signed push (still reads rank from ENS only).

## Commit phases

1. plan (this file).
2. config: ingest secret + port.
3. identity.ts: signature verify + parse + http server.
4. bot.ts/index.ts: drop /link, wire linkMember + start server.
5. tests + env.example/description.

## Cross-boundary vector

secret `test-webhook-secret`, body
`{"discord_id":"123456789012345678","display_name":"alice"}` →
`sha256=17b4e564881090b47a069536a2910a6d16a444629b706c44a81d898fa65621ed`.
Asserted identically here and in calibre.

## Test command

`cd discord-bot && npm install && npm test`
