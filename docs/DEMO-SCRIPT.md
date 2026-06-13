# Demo video — script & storyboard (ETHGlobal NYC 2026)

Target length **~3 minutes**. The arc: a new user onboards with a Dynamic wallet,
funds with one Blink tap, buys on-chain on Arc, then the **hero closer** — a real
Valorant match resolves, settles on Arc, the user's ENS rank updates, and their
Discord role flips on screen.

> **`[OWNER: record after deploy]`** — every shot needs the live artifacts that
> are owner/booth-gated (deployed Arc address, funded wallet, real Dynamic
> environment, deployed ENS resolver pointed at the booth parent name, Discord bot
> in a server). See [`SUBMISSIONS.md`](SUBMISSIONS.md) "Owner / booth residual."
> Capture a contingency cut on **local anvil** (the deterministic W1.3 round-trip)
> if live Arc is flaky during recording.

---

## Cold open (0:00–0:15) — the one-liner

**On screen:** calibre dashboard, a live Valorant market ticking (LMSR price
moving from real order flow + bots).
**VO:** "Calibre is a live Valorant prediction market — off-chain LMSR,
points-denominated, with autonomous market-maker bots. This weekend we took it
on-chain: markets settle in USDC on Arc, wallets and signing through Dynamic,
deposits via Blink, and a portable forecasting reputation over ENS."
**Caption:** *Continuity track — the on-chain feature is a new open-source repo:
`calibre-onchain`.*

---

## Segment 1 (0:15–0:45) — Dynamic onboarding (#426/#427)

**Shots:**
1. Existing magic-link sign-in (the "before").
2. Click **Connect Wallet** → Dynamic modal → embedded wallet created → address
   shown.
3. Behind it (small inset / devtools): `POST /api/v1/accounts/wallet` 200 — JWT
   verified, `wallet_address` bound to the account.

**VO:** "Onboarding is still email magic-link — but now you also get a Dynamic
embedded wallet. Calibre verifies the Dynamic JWT and binds the wallet to your
account; the wallet is your on-chain identity for everything that follows."
**Caption:** *Seam 3 — Dynamic ↔ accounts. JWT verified server-side; verified
address only.*
`[OWNER: needs real DYNAMIC_ENVIRONMENT_ID]`

---

## Segment 2 (0:45–1:05) — Blink one-tap deposit (#428)

**Shots:**
1. **Deposit** affordance → single tap → USDC balance appears.
2. Inset: callback verified (HMAC), balance credited idempotently.

**VO:** "Funding is one tap with Blink — USDC lands at your wallet and never
leaves the app. Blink owns deposits; Dynamic owns the wallet and signing — no
overlap."
**Caption:** *Seam 3 — Blink deposit. Idempotent credit; HMAC-verified callback.*
`[OWNER: needs live Blink keys + the booth-confirmed destination param]`
> If the 3-partner cap forces ENS-in/Blink-out, **cut this segment** and extend
> the ENS closer.

---

## Segment 3 (1:05–1:45) — on-chain buy on Arc (A-lite, #427/#424)

**Shots:**
1. Pick a live market; open the on-chain ticket.
2. Calibre returns a **signed EIP-712 voucher** (`POST /markets/{id}/onchain-quote`)
   — show the `Quote` fields and the `≤30s` expiry countdown.
3. `approve` + `buy([Quote], cost, sig)` from the Dynamic wallet → **tx on Arc**.
4. Open the tx on arcscan: `Bought` event, USDC moved, shares credited.

**VO:** "Prices stay in our off-chain LMSR — that's the A-lite model. The backend
signs an EIP-712 price voucher; the contract verifies the signature, enforces the
nonce, expiry, and slippage ceiling, and moves shares from pre-minted inventory.
A real signed buy on Arc testnet — the A-lite differentiator."
**Caption:** *Arc — `buy(quote, sig)`. Off-chain LMSR, on-chain custody.
Complete-set solvent by construction.*
`[OWNER: deployed CalibreMarket address + a real signed buy tx]`

---

## Segment 4 (1:45–2:05) — autonomous agent (Dynamic agentic / Arc agentic)

**Shots:**
1. The standalone agent quoting on the same market from a **Dynamic server
   wallet** (terminal log of signed txs).
2. Show the kill switch + inventory cap (dry-run → live).

**VO:** "An open-source market-maker agent quotes on the same contract from its own
Dynamic server wallet, using our public price feed as its prior — bounded by a
kill switch and an inventory cap."
**Caption:** *Seam 4 — public agent, private prior stays private.*
`[OWNER: funded Arc server wallet]`

---

## Segment 5 — THE HERO CLOSER (2:05–2:50) — on-chain → ENS → Web2

The single continuous motion. Keep the Discord window visible the whole time.

**Shots (one take if possible):**
1. A real Valorant match resolves — VLR pipeline detects the result.
2. Calibre resolves the market in the points ledger, **and** the never-raise hook
   calls `resolve(marketId, YES)` on Arc → show the resolve tx + the user
   redeeming winning shares for USDC.
3. Rank recomputes (recency-decayed Brier → percentile → tier, e.g. **"Sharp"**).
4. Resolve `<user>.calibre.eth` `text("gg.calibre.rank")` in an ENS-aware client →
   it returns the **new** tier (via the CCIP-read gateway — no on-chain write).
5. **Cut to Discord:** the role-sync bot reads `gg.calibre.rank` from ENS and the
   user's role **visibly flips** to the new tier.

**VO:** "Here's the whole thesis in one motion. A real match resolves; the market
settles in USDC on Arc; your forecasting rank recomputes and updates as an ENS
text record — free and instant, because the resolver reads our DB over CCIP-read;
and a Discord bot reading that record from ENS flips your role on screen.
On-chain to ENS to Web2 — seconds apart."
**Caption:** *The hero flow — see [`ARCHITECTURE.md`](ARCHITECTURE.md) §3.*
`[OWNER: deployed ENS resolver + booth parent name + Discord bot in a live server]`

---

## Close (2:50–3:00)

**On screen:** the `calibre-onchain` README + the partner logos (Arc, Dynamic,
Blink, ENS).
**VO:** "Calibre on-chain — open source, MIT, built this weekend. The private app
keeps running on points; the on-chain layer is the new public repo."
**Caption:** `github.com/HANSEL-LI/calibre-onchain`

---

## Production checklist (owner)

- [ ] Deploy `CalibreMarket.sol` to Arc testnet; note address + a resolve tx.
- [ ] Fund the demo user wallet + the agent server wallet (faucet.circle.com).
- [ ] Real Dynamic environment configured (`DYNAMIC_ENABLED=true`).
- [ ] Blink keys + destination param (or cut Segment 2 per the cap).
- [ ] ENS offchain resolver deployed + parent name pointed at the gateway.
- [ ] Discord bot in a server with Manage Roles + bot role above the tier roles.
- [ ] Have a **local-anvil contingency cut** of Segments 3 + 5 ready (deterministic
      W1.3 round-trip) in case live Arc is flaky on camera.
- [ ] Final video link → drop into [`SUBMISSIONS.md`](SUBMISSIONS.md) +
      README + every prize form.
