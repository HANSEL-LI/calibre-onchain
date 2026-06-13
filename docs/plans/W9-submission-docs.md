# W9 — ETHGlobal submission package (calibre#433)

Submission-quality docs for the ETHGlobal NYC 2026 Continuity build. **Docs only,
no code.** These are judged surfaces, so every claim is grounded in merged work
(decision-log calibre#440 + the actual files in this repo and the private app).

## What this PR delivers (2 of the 3 issue deliverables; the video is owner-gated)

1. **`docs/ARCHITECTURE.md`** — the full system: private calibre (LMSR engine,
   points ledger, VLR pipeline, Seam glue) ↔ public `calibre-onchain`
   (CalibreMarket Arc contract + EIP-712 voucher, ENS CCIP-read gateway, Discord
   role-sync bot, on-chain agent, ranking lib, SDK). Mermaid diagrams (render on
   GitHub) for: system context, the four seams, and the hero data-flow
   (VLR resolve → on-chain resolve → ENS rank text-record → Discord role flip).
   Arc requires an architecture diagram.
2. **`docs/SUBMISSIONS.md`** — one section per prize from the overview table.
   Each: what we built, how the integration works, the merged PRs/files that
   implement it, the repo link, and `[OWNER-FILL: …]` placeholders where a
   deployed address / live URL / video link is needed.
3. **`docs/DEMO-SCRIPT.md`** — storyboard for the hero flow + onboarding (Dynamic
   #426/#427), Blink deposit (#428), on-chain buy/redeem (#427). Marked
   `[OWNER: record after deploy]`.
4. **README** — refresh the stale "W0 scaffold" status banner to "code-complete"
   and link the three new docs; update the package map note. Minimal touch.

## Named commit phases

- `docs(W9): submission package plan` — this file.
- `docs(W9): architecture diagram + data-flow (calibre#433)` — `ARCHITECTURE.md`.
- `docs(W9): per-prize submission write-ups (calibre#433)` — `SUBMISSIONS.md`.
- `docs(W9): demo video script + storyboard (calibre#433)` — `DEMO-SCRIPT.md`.
- `docs(W9): link submission docs from README (calibre#433)` — README edits.

## Decisions

- **Mermaid for the diagrams** (renders inline on GitHub, judges read it without
  tooling); kept text-legible so it doubles as the source for an exported SVG the
  owner can attach to the Arc form.
- **No invented capabilities.** Built-and-tested vs `[OWNER-FILL]`/`[OWNER:]`
  pending-live-deploy is called out explicitly throughout. Live Arc addresses,
  the deployed ENS resolver, a real Dynamic environment, and a funded wallet are
  all owner/booth-gated per #440 and stay as placeholders.
- **Submission docs live in `calibre-onchain`** (the public, judge-readable repo),
  per briefing §4 — these are public artifacts.

## Risks

- Stale claims = the only real risk on a judged doc. Mitigated by grounding every
  line in #440's per-issue decisions + the actual merged files.

## Test command

Docs only — no tests. Sanity: `mermaid` blocks render on GitHub; internal links
resolve. No code paths touched.
