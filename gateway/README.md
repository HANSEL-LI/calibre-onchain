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
| `sharks.calibre.eth` | a `sharks` user lookup (no clan-aggregate endpoint yet) |
| `calibre.eth` | nothing (bare parent) |

Clan nesting (`<user>.<clan>.calibre.eth`) is an **addressing convenience**: the
`<clan>` label is namespacing, so the leftmost label is always the calibre
`display_name` and a nested name resolves the same user as the flat form. There
is no clan-aggregate profile in Seam 2 this weekend, so a bare clan name is
looked up as a user and yields the empty record for a non-profile label — the
same indistinguishable empty answer as any unknown name (no enumeration oracle).
The clan-membership cross-check is a W6.4 concern.

## Record-key mapping (profile JSON → ENS records)

The canonical `gg.calibre.*` key schema is owned by
[`../ranking/`](../ranking/) (`calibre_ranking.TEXT_KEYS`). This TypeScript
gateway can't import that Python module, so it keeps its own
`TEXT_RECORD_KEYS` map (in `src/profile.ts`) which **mirrors** that schema.

The profile API returns
`{ display_name, tier, brier_skill, roi, pnl, wallet_address, discord_handle, riot_id, clan }`.

| ENS query | Source field |
|---|---|
| `addr(node)` / `addr(node, 60)` | `wallet_address` (coinType 60 / ETH) |
| `text(node, "gg.calibre.rank")` | `tier` |
| `text(node, "gg.calibre.brier")` | `brier_skill` |
| `text(node, "gg.calibre.roi")` | `roi` |
| `text(node, "com.discord")` | `discord_handle` |
| `text(node, "gg.calibre.riot")` | `riot_id` |
| `text(node, "gg.calibre.clan")` | `clan` |

A non-existent / not-opted-in / bot subname → the profile API returns an
indistinguishable 404 → the gateway answers with the **empty value** (`0x` for
`addr`, `""` for `text`), the same as an unset record. No enumeration oracle.

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
