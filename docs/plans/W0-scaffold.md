# W0 — Scaffold `calibre-onchain` package skeleton

Tracker issue: `HANSEL-LI/Calibre#417` (targets this public repo).
Part of the ETHGlobal NYC 2026 Continuity umbrella (`HANSEL-LI/Calibre#415`).

## Goal

The public `calibre-onchain` repo (MIT, already created with a starter README +
LICENSE) gains the agreed package skeleton and a README that states the
public/private boundary. This is build-order step 0 — the open-source
scaffolding every cross-repo sub-issue (W1.x, W6.2–W6.4, W7.2) hangs off.

This PR ships **a skeleton only**: directory structure, package manifests,
placeholder entrypoints, a working Foundry toolchain. No contract / gateway /
agent / SDK *logic* — those are W1.1, W6.2, W7.2, etc.

## Package map (from `docs/ethglobal-nyc-2026-interface.md`)

| Package | Contents | Language |
|---|---|---|
| `contracts/` | `CalibreMarket.sol` — mint/trade/resolve/redeem in USDC; deploy scripts; tests | Solidity (Foundry) |
| `gateway/` | ENS CCIP-read (ENSIP-10) resolver gateway for `*.calibre.eth` | TS |
| `discord-bot/` | Role-sync bot: subname → `gg.calibre.rank` → Discord role | TS |
| `ranking/` | Pure rank-bucketing lib + canonical `gg.calibre.*` text-record key schema | Python |
| `agent/` | Standalone on-chain market-maker agent (Dynamic server wallet + public price feed prior) | Python |
| `sdk/` | `calibre_onchain` pip package the private app imports (contract client, tx signing) | Python |

## Decisions

- **Foundry over Hardhat** for `contracts/`. The issue names "Solidity/Foundry"
  explicitly and requires `forge build` to succeed; Foundry is the lighter,
  judge-legible toolchain for a single settlement contract. (Forge 1.7.1.)
- **`agent/` in Python**, not TS. The interface doc lists "Python or TS"; the
  agent reads calibre's public price feed and shares the `ranking/` Python lib's
  idiom, so Python keeps the on-chain-services language split clean (TS only for
  the two ENS/Discord HTTP services).
- **`sdk/` and `ranking/` each get their own `pyproject.toml`** (two independent
  pip-installable packages) rather than one umbrella package: the private app
  imports `calibre_onchain` (SDK) and the `ranking` lib independently, and
  `ranking/` is also imported by the gateway-adjacent tooling. Keeping them
  separate matches the one-way dependency direction in the interface doc.
- **Placeholder source files are valid-but-empty stubs**: `forge init`-style
  contract scaffold so `forge build` compiles; TS packages get a `package.json`
  + `src/index.ts` stub + `tsconfig.json`; Python packages get `pyproject.toml`
  + an `__init__.py` (or module) with a docstring and no logic.
- **CI: a single trivially-fast `forge build` smoke workflow** for `contracts/`.
  The issue says CI is nice-to-have, add only if trivially fast — a Foundry
  build check is one job and protects the W1.1 starting toolchain. No TS/Python
  CI (those packages are empty stubs this PR).
- **Root `.gitignore` and `.env.example`** added: the interface doc says the
  public repo ships `.env.example` placeholders only (no real keys/URLs), and
  the build artifacts (`out/`, `cache/`, `node_modules/`, `lib/`, `.venv/`)
  must never be committed to a public repo.

## Commit phases

1. `docs(plan): W0 scaffold plan` — this file (first commit, proves the plan).
2. `chore(repo): root scaffolding` — `.gitignore`, `.env.example`, expanded
   `README.md` with the package map + public/private boundary contract.
3. `feat(contracts): Foundry skeleton` — `contracts/foundry.toml`,
   `src/CalibreMarket.sol` placeholder, `test/`, `script/`, `forge-std` as a
   git submodule via `forge install`, `.gitmodules`. `forge build` must pass.
4. `feat(services): TS package stubs` — `gateway/` + `discord-bot/`
   (`package.json`, `tsconfig.json`, `src/index.ts`).
5. `feat(python): SDK + ranking + agent stubs` — `sdk/`, `ranking/`, `agent/`
   pyproject + placeholder modules.
6. `ci: forge build smoke` — `.github/workflows/contracts.yml`.

## Risks

- `forge install forge-std` needs network + adds a submodule; if the submodule
  vendoring is flaky, fall back to a remapping-only `foundry.toml` with a
  minimal hand-written interface so `forge build` still compiles. (Primary path:
  submodule.)
- Public-repo hygiene: every file is public from the first commit — no keys,
  prod URLs, or private LMSR/bot logic. `.env.example` is placeholders only.

## Test

- `cd contracts && forge build` (must compile — the issue's success criterion).
- `gh repo view HANSEL-LI/calibre-onchain --json visibility,licenseInfo`
  (public + MIT — already true, asserted not changed).
- No unit tests this PR (skeleton only; the contract has no logic yet).
