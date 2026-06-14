# gateway — ENS CCIP-read resolver for `*.calibre.eth`

An ENSIP-10 / EIP-3668 **offchain resolver gateway**. A standard ENS client
(viem/ethers) resolving `<name>.calibre.eth` hits the on-chain resolver, follows
its `OffchainLookup` to this gateway, and gets back a **signed** answer for the
name's `addr()` and `gg.calibre.*` / `com.discord` text records.

calibre's DB is the source of truth: the gateway reads only the **public profile
API** (Seam 2) over HTTP and never touches the database. "Updating a text
record" = updating calibre's DB — free and instant, yet resolvable by any
ENS-aware client. (W6.2 — `HANSEL-LI/Calibre#429`.)

## How it works

```
ENS client ──resolve()──► calibre.eth resolver (on-chain)
                                │ reverts OffchainLookup([gatewayUrl], …)
client ──POST {sender,data}──►  gateway
gateway ──GET /profiles/{name}──► calibre public API ──► record value
gateway ──► { data: abi.encode(bytes result, uint64 expires, bytes sig) }
client ──resolveWithProof──► resolver verifies the signer ──► record
```

The gateway parses the **leftmost** label of the subname as the calibre
`display_name`, fetches `GET {CALIBRE_PUBLIC_API_BASE}/profiles/{name}`, encodes
the record answer, and signs it with `GATEWAY_SIGNER_KEY` per the
`ensdomains/offchain-resolver` scheme:

```
sig over keccak256(abi.encodePacked(
  0x1900, target, expires:uint64, keccak256(request), keccak256(result)))
```

## Name shapes

| Name | Resolves to |
|---|---|
| `demo.calibre.eth` | the `demo` user profile (flat subname) |
| `demo.sharks.calibre.eth` | the `demo` user profile (clan-nested, W6.3 / F4) |
| `sharks.calibre.eth` | the `sharks` user if one exists, else the `sharks` **clan-aggregate** profile (#583) |
| `calibre.eth` | nothing (bare parent) |

Clan nesting (`<user>.<clan>.calibre.eth`) is an **addressing convenience**: the
`<clan>` label is namespacing, so the leftmost label is always the calibre
`display_name` and a nested name resolves the same user as the flat form.

A **bare** `<clan>.hicalibre.eth` (3 labels) is ambiguous — it could be a flat
user subname or a clan. The gateway resolves it **user-first**: it tries the
leftmost label as a user, and only when no such user exists does it serve
clan-aggregate text records (`gg.calibre.clan.*`, #583) from `GET /clans/{clan}`.
So a real user name always resolves as a user; a clan-only label resolves the
clan. An unknown bare label yields the empty record (no enumeration oracle).
`addr()` is a user-only record, so a clan-only name resolves `addr()` to the
zero address.

## Record-key mapping (profile JSON → ENS records)

The canonical `gg.calibre.*` key schema is owned by
[`../ranking/`](../ranking/) (`calibre_ranking.TEXT_KEYS`). This TypeScript
gateway can't import that Python module, so it keeps its own
`TEXT_RECORD_KEYS` map (in `src/profile.ts`) which **mirrors** that schema.

That mirror is enforced, not just documented: `ranking/` emits its key set to a
committed `ranking/keys.json` fixture, and `test/keys-schema.test.ts` (in the
`npm test` run) asserts `Object.keys(TEXT_RECORD_KEYS)` set-equals that fixture.
A key added/renamed on either side fails the build (#445).

The profile API returns
`{ display_name, tier, brier_skill, roi, pnl, win_rate, n_resolved, streak, wallet_address, discord_handle, riot_id, clan, avatar, url, description }`.

| ENS query | Source field |
|---|---|
| `addr(node)` / `addr(node, 60)` | `wallet_address` (coinType 60 / ETH) |
| `text(node, "gg.calibre.rank")` | `tier` |
| `text(node, "gg.calibre.brier")` | `brier_skill` |
| `text(node, "gg.calibre.roi")` | `roi` |
| `text(node, "gg.calibre.winrate")` | `win_rate` (#597) |
| `text(node, "gg.calibre.resolved")` | `n_resolved` (#597) |
| `text(node, "gg.calibre.streak")` | `streak` (#597) |
| `text(node, "com.discord")` | `discord_handle` |
| `text(node, "gg.calibre.riot")` | `riot_id` |
| `text(node, "gg.calibre.clan")` | `clan` |

A non-existent / not-opted-in / bot subname → the profile API returns an
indistinguishable 404 → the gateway answers with the **empty value** (`0x` for
`addr`, `""` for `text`), the same as an unset record. No enumeration oracle.

### Clan-aggregate records (`<clan>.hicalibre.eth`, #583)

A bare clan name with no matching user serves a **separate** clan-key namespace
from `GET /clans/{clan}` (the calibre clan-aggregate endpoint). These keys live
in `CLAN_TEXT_RECORD_KEYS` (in `src/profile.ts`) — deliberately **not** part of
the canonical user-key drift contract above (they describe a clan, not a user):

| ENS query | Source field |
|---|---|
| `text(node, "gg.calibre.clan.size")` | `size` (member count) |
| `text(node, "gg.calibre.clan.avgrank")` | `avg_rank` (tier of mean member skill) |
| `text(node, "gg.calibre.clan.brier")` | `brier_skill` (pooled clan Brier) |
| `text(node, "gg.calibre.clan.median")` | `median_brier_skill` (median of scored members) |
| `text(node, "gg.calibre.clan.roi")` | `roi` (aggregate) |
| `text(node, "gg.calibre.clan.top")` | `top_member` (highest-skill member's display_name) |

The existing single `gg.calibre.clan` user key (a *user's* clan label) is
distinct from these dotted aggregate keys, so the two namespaces don't collide.

## Run

```sh
cp ../.env.example ../.env   # fill in testnet values (placeholders only in the repo)
npm install
npm run build
npm start                    # listens on GATEWAY_PORT (default 8080)
```

Environment (see the repo-root `.env.example`):

- `GATEWAY_PORT` — HTTP listen port (default `8080`).
- `CALIBRE_PUBLIC_API_BASE` — calibre public API base, e.g.
  `https://app.hicalibre.gg/api/v1`.
- `GATEWAY_SIGNER_KEY` — 32-byte hex signing key (testnet only). Its address
  must be allowlisted in the on-chain resolver.
- `GATEWAY_RESOLVER_ADDRESS` — the resolver this gateway signs for. The signed
  `target` actually comes from the request's `extraData`, so the gateway runs
  and is testable without it; this value is for logging / the health echo.

`GET /health` → `{ ok, resolver, apiBase }`. The EIP-3668 endpoint accepts both
`POST /` with `{ sender, data }` and the `GET /:sender/:data` template form.

## On-chain side

[`contract/OffchainResolverStub.sol`](contract/OffchainResolverStub.sol) is the
reference resolver documenting the signature scheme (`resolve` →
`OffchainLookup` → `resolveWithProof` verifies an allowlisted signer). It is a
reference artifact — deploying it and pointing a real `calibre.eth` (or the
testnet equivalent the ENS booth designates) at the gateway URL is a demo-day
op, gated on `GATEWAY_RESOLVER_ADDRESS`.

## Test

```sh
npm test   # tsc typecheck + node:test suite
```

Covers: DNS-name decode, the record mapping, `addr`/`text` ABI encode, the
unknown-subname and unset-record empty paths, and a signature round-trip
verified by recovering the signer with viem.

## Deploy

Stateless by design — a crash is a redeploy. Any small Node host works
(fly.io / render / a VPS systemd unit): set the env vars, `npm ci && npm run
build`, run `npm start` behind TLS, and put the public URL in the on-chain
resolver's `url`.
