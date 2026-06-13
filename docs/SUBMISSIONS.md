# Prize submissions — Calibre on-chain (ETHGlobal NYC 2026)

One section per prize. Each states **what we built**, **how the integration
works**, the **merged PRs/files** that implement it, and the **open-source repo
link**. `[OWNER-FILL: …]` marks where a deployed artifact (Arc address, live URL,
demo video) is needed before submit.

**Open-source repo (the weekend feature):**
<https://github.com/HANSEL-LI/calibre-onchain> · MIT · first commit timestamped
after event start (Continuity "Ship a Feature" rule).

**Architecture diagram:** [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) (Arc requires
one). **Demo video:** [`docs/DEMO-SCRIPT.md`](DEMO-SCRIPT.md) ·
`[OWNER-FILL: demo video link]`.

**One-liner used across forms:** Calibre — a live Valorant prediction-markets
platform (off-chain LMSR, points-denominated, autonomous market-maker bots) —
goes on-chain for the weekend: a subset of markets settle in **USDC on Arc**,
users onboard with **Dynamic** wallets and fund via **Blink**, and carry a
portable forecasting reputation served over **ENS** and enforced as Discord
roles.

> **Status convention:** ✅ merged + tested · 🔌 code complete, awaiting a live
> deploy / credential (owner/booth-gated per calibre#440).

---

## Arc — Best Prediction Markets with Real-World Signal ($2,150) · primary

**What we built.** An on-chain USDC settlement layer for a *live* prediction
market whose real-world signal is professional Valorant match outcomes. The
resolution oracle is calibre's existing VLR.gg scrape pipeline: when a real match
resolves, the backend calls `resolve(marketId, outcome)` on Arc and winners
redeem 1:1 for USDC. The market price is a real LMSR over live order flow and
autonomous market-maker bots — not a static demo.

**How the integration works.**
- `CalibreMarket.sol` uses **complete-set minting** — 1 USDC mints 1 YES + 1 NO
  share — so the contract is solvent by construction (no house-capitalization
  step). `resolve` is `onlyResolver`, one-shot, YES|NO; `redeem` pays winning
  shares 1:1 and the contract drains to zero.
- The **real-world signal** is a one-way bridge from the private VLR pipeline:
  `settlement._resolve_market` → `onchain_bridge` (never-raise, post-commit) →
  `calibre_onchain` SDK → `resolve(chainMarketId, YES|NO)` with the resolver key.
- Proven end-to-end on a real broadcast (W1.3 checkpoint): deploy →
  seedInventory → voucher buy → resolve → redeem → drain-to-zero, total USDC
  conserved.

**Implemented by.** `contracts/src/CalibreMarket.sol`,
`contracts/script/Deploy.s.sol`, `contracts/script/EndToEnd.s.sol`,
`contracts/test/CalibreMarket.t.sol`, `sdk/` (calibre-onchain #2, #3, #7) · private
bridge `src/calibre/markets/onchain_bridge.py` (calibre PR #442, W4.1/#425).

🔌 `[OWNER-FILL: deployed CalibreMarket address on Arc testnet + a resolve tx hash
on arcscan]`.

---

## Arc — Continuity: Extend the Arc Ecosystem ($2,100)

**What we built.** Calibre is a pre-existing, private, commercial product. The
*newly created* weekend feature is the entire `calibre-onchain` repo: it **adds
Arc settlement to an existing prediction-markets product** without rewriting the
product. The private app keeps running on points; a subset of markets gain
on-chain mirrors. Every flag defaults OFF — Arc is additive, not a fork.

**How the integration works.** The public/private split *is* the Continuity
story: the open-source repo exposes APIs / services / contracts; the private app
consumes them (Python SDK import + HTTP). The boundary is documented and
enforced — public components never import private code or touch the DB. See
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) §1–2.

**Commit hygiene (judges check).** Real commits spread across the weekend — 11
merged PRs in `calibre-onchain` plus a parallel stream of private glue PRs, each
plan-first with a `## Decisions made` section, all mirrored to the continuous
decision log (calibre#440). First commit timestamped after event start.

**Implemented by.** The whole repo; the boundary doc; calibre#440 (commit
timeline).

🔌 `[OWNER-FILL: live URL of the running calibre app showing on-chain settlement +
demo video link]`.

---

## Arc — Advanced Stablecoin Logic ($3,250) · stretch

**What we built.** The settlement/payout logic is non-trivial along three axes:

1. **Complete-set solvency** — every outstanding (YES + NO) pair is backed by
   exactly one locked USDC unit; the contract can always pay every winner and
   drains to zero (verified by the W1.3 broadcast).
2. **EIP-712 voucher buys with calibre as standing counterparty (A-lite).** Price
   discovery stays in the off-chain LMSR; the chain verifies a backend-signed
   `Quote(marketId, buyer, side, size, maxCost, nonce, expiry)` and atomically
   pulls USDC + moves shares from pre-minted counterparty inventory. Replay
   protection (per-buyer monotonic nonce), `≤30s` expiry, `cost ≤ maxCost`
   slippage ceiling, and a per-market notional cap bound a compromised signer.
3. **Decimals correctness** — `usdcUnit` is read from `token.decimals()`, so the
   logic respects Arc's 6-decimal ERC-20 USDC and never the 18-decimal native gas
   asset (W8 spike §3). Cross-language EIP-712 digest parity is verified against
   the deployed `hashQuote` (a real bug — wrong struct/field encoding — was caught
   at review and fixed before merge).

**How the integration works.** See `CalibreMarket.sol` `buy()` / `hashQuote()`
and [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) §4.

**Implemented by.** `contracts/src/CalibreMarket.sol` (voucher extension,
calibre-onchain #5, W1.2/#422), `contracts/test/CalibreVoucher.t.sol`; private
signer `src/calibre/markets/onchain_voucher.py` (calibre PR #443, W3.1/#424).

🔌 `[OWNER-FILL: a signed buy(quote, sig) tx hash on Arc testnet]`.

---

## Arc — Agentic Economy ($3,250) · stretch

**What we built.** A standalone, open-source on-chain market-maker **agent** that
quotes on the Arc contract from its own wallet, using calibre's live market price
as its prior. It is *newly created* for the weekend — not a wrapper over the
private bot fleet (whose archetype bodies stay closed).

**How the integration works.**
- The agent reads its prior from the public price feed
  `GET /api/v1/markets/public/{id}/price` (Seam 4) — no auth, no private imports.
- It signs and broadcasts via a **Dynamic server wallet** (the bounty path) with
  a local-key testnet fallback; both yield raw signed bytes, so the loop is
  signer-agnostic.
- Its making leg uses the W1.2 voucher `buy(quote, sig)` path (swapped from
  mint-based after #422 merged), with `hashQuote` digest parity verified by forge.
- **Safety rails:** dry-run defaults ON; spend is hard-bounded by an inventory
  cap; a kill switch halts it — a bad signal is bounded.

**Implemented by.** `agent/` (calibre-onchain #6, W7.2/#432; voucher swap #10,
#444); private price endpoint `src/calibre/markets/router.py` `public_router`
(calibre PR #438, W7.1/#420).

🔌 `[OWNER-FILL: a funded Arc server wallet + a live agent buy tx hash; confirm
Circle Gateway / x402 availability if claiming the rail]`.

---

## Dynamic — Best Agentic Build **or** Wallet Glow Up ($2,000)

**What we built (both halves; pick primary at the booth).**
- **Wallet Glow Up:** Dynamic embedded-wallet onboarding *alongside* the existing
  email magic-link auth. Clean before/after: "magic-link points app →
  embedded-wallet USDC app." The Dynamic wallet is the user's on-chain identity —
  holds USDC shares, signs voucher buys and redeems.
- **Agentic:** the on-chain agent (above) signs from a **Dynamic server wallet**.

**How the integration works.**
- **Backend:** `POST /api/v1/accounts/wallet` verifies the Dynamic JWT against the
  JWKS at `app.dynamic.xyz/<environment_id>` (RS256 pinned, TTL-cached); the
  verified address comes from `verified_credentials[]` only, never
  client-supplied; bound to `users.wallet_address`. Hardening added opt-in `aud`
  verification and a global one-wallet-per-user unique index. The user UUID stays
  canonical — Dynamic complements `calibre_sid`, doesn't replace it.
- **Frontend:** `@dynamic-labs/client` loaded via CDN lazy `import()` (not
  bundled — `app.bundle.js` stays byte-stable when the flag is off); connect →
  Dynamic login → JWT → `POST /accounts/wallet` → reflects in `/me`.
- **Signing:** the SPA `onchain-ticket` component fetches a calibre-signed voucher
  → ensures USDC allowance → `approve` + `buy([Quote], cost, sig)` →
  `redeem(marketId)` via the user's Dynamic embedded wallet (viem WalletClient).

**Implemented by.** `src/calibre/accounts/dynamic_jwt.py`,
`src/calibre/accounts/router.py` (calibre PR #436, W2.1/#418; PR #446, #437);
`app/components/wallet-modal.js` (PR #448, W2.2/#426);
`app/components/onchain-ticket.js` (PR #449, W2.3/#427); agent server-wallet
signer `agent/src/calibre_agent/signer.py` (calibre-onchain #6).

🔌 `[OWNER-FILL: real DYNAMIC_ENVIRONMENT_ID; live browser proof of connect → link
→ sign]`.

---

## Blink — Best consumer app (Continuity) ($2,000)

**What we built.** A one-tap USDC deposit as **the** funding path: the user taps
once, USDC arrives at their linked wallet / in-app balance, never leaving the app.
Deliberate non-overlap with Dynamic — **Blink owns deposits, Dynamic owns wallets
+ signing** — so neither integration reads as cosmetic.

**How the integration works.**
- Destination = the user's linked `wallet_address` (Seam 3) via
  `BLINK_DESTINATION_MODE`; graceful degradation to an in-app USDC balance credit.
- **Money path safety:** the fallback credit reuses the points ledger `post_entry`
  with `idempotency_key = blink_deposit:{provider_ref}`, so a replayed callback
  never double-credits. USDC currency only — POINTS untouched.
- Callback auth = fail-closed HMAC-SHA256 over the raw body.
- SPA widget falls back to a toast when the Blink SDK is absent.

**Implemented by.** `src/calibre/web/deposit_api.py`, `app/components/deposit.js`,
`src/calibre/data/repos/points.py` (calibre PR #447, W5.1/#428).

> **3-partner-cap caveat (briefing §2):** if submissions are hard-capped at three
> partners, the trade is **ENS in / Blink out** ($9k vs $2k). Blink is one flag
> from dormant and nothing depends on it — cheap to drop if the cap resolves that
> way.

🔌 `[OWNER-FILL: exact Blink destination-address API param + callback-signing
scheme (booth) + live BLINK_API_KEY/BLINK_WEBHOOK_SECRET; demo deposit]`.

---

## ENS — Best ENS Continuity Integration ($4,000)

**What we built.** A portable forecasting-reputation layer over ENS. Users claim
`<name>.calibre.eth`; their live rank, Brier skill, and ROI are served as ENS
text records sourced from calibre's DB via an **offchain (CCIP-read) resolver** —
so a value that changes on every market resolution stays free and instant to
update, yet resolvable by any ENS-aware client.

**How the integration works.**
- **Offchain resolver gateway (ENSIP-10 / EIP-3668):** `gateway/` serves
  `addr()` + `text()` for `*.calibre.eth`, signing CCIP-read answers per
  `ensdomains/offchain-resolver`. Its sole data source is the public profile API
  (Seam 2) — no DB, no private data; a non-opted-in / unknown name returns the
  *empty* record (no enumeration oracle).
- **Text-record schema** (canonical in `ranking/keys.py`, mirrored TS-side with a
  drift guard): `gg.calibre.rank` (tier), `gg.calibre.brier`, `gg.calibre.roi`,
  `gg.calibre.clan`, `gg.calibre.riot`, `com.discord`. Performance records are
  *earned* — written from real resolutions, never hard-coded.
- **No hard-coded values:** identity comes from real OAuth/verification, rank from
  the recency-decayed Brier skill score (`user_calibration_scores`) bucketed by
  the public `ranking/` lib — the exact code judges can read.

**Implemented by.** `gateway/` (calibre-onchain #4, W6.2/#429; subnames #8,
W6.3/#430), `ranking/` (#8, #11), `gateway/contract/OffchainResolverStub.sol`
(documented, non-deployed); private profile API `src/calibre/web/profiles_api.py`
(calibre PR #439, W6.1/#419).

🔌 `[OWNER-FILL: deployed offchain resolver address + GATEWAY_RESOLVER_ADDRESS;
the booth-designated parent name (calibre.eth or the testnet equivalent) pointed
at the gateway]`.

---

## ENS — Most Creative Use of ENS ($5,000)

**What we built.** Three things that make ENS *load-bearing*, not decorative:

1. **Clans as nested subname registries** — `<user>.<clan>.calibre.eth`. The
   `<clan>` label is addressing/namespacing that resolves the user leaf; the
   structure expresses team membership in the name itself.
2. **CCIP-read reputation** — rank/skill/ROI as live ENS text records backed by an
   offchain resolver, so a constantly-changing forecasting reputation is portable
   over ENS without per-update gas.
3. **Roles-from-ENS** — a Discord bot resolves members' `<name>.calibre.eth`,
   reads `gg.calibre.rank` with a **standard ENS library** (viem `getEnsText`,
   zero calibre-API calls), and assigns the matching Discord role. ENS is the
   credential layer *between* calibre and Discord — the closing demo beat:
   **on-chain market resolves → rank updates → ENS record resolves the new value →
   the user's Discord role visibly flips.**

**How the integration works.** The rank ladder
(`Static → Hunch → Read → Edge → Sharp → Seer → Oracle`, top tiers scarce) is a
pure percentile→tier bucketer (`ranking/tiers.py`) — deliberately *not* Valorant's
rank names (Riot IP). The bot assigns **rank-tier roles only** — no
position/ROI/Brier leakage (asserted by a privacy test); unknown/Unranked → no
role.

**Implemented by.** `gateway/src/resolver.ts` (clan nesting),
`ranking/src/calibre_ranking/tiers.py` + `keys.py`, `discord-bot/` (calibre-onchain
#8, #9, W6.3/#430 + W6.4/#431), schema drift guard (#11, #445).

🔌 `[OWNER-FILL: deployed resolver pointing the testnet parent name; a live demo of
the role flip; ENS-booth presentation (Sunday AM — block the time)]`.

---

## Owner / booth residual (not buildable in code — calibre#440)

These gate *submission*, not the build. Every code path above is merged and
tested; each activates on configuration.

- Deploy `CalibreMarket.sol` to Arc testnet → record the address + a resolve tx.
- Fund an Arc testnet wallet (treasury + agent server wallet).
- Create a real Dynamic environment → `DYNAMIC_ENVIRONMENT_ID`.
- Deploy the ENS offchain resolver + point the booth-designated parent name at the
  gateway → `GATEWAY_RESOLVER_ADDRESS`.
- Confirm the exact Blink destination param + callback-signing scheme at the booth.
- Record the demo video ([`DEMO-SCRIPT.md`](DEMO-SCRIPT.md)).
- Resolve the **3-partner cap** (ENS-in / Blink-out if hard-capped).
- File each prize submission + present at the ENS booth Sunday AM.
