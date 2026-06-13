# 468 — `sdk/` package test suite

**Target repo:** `calibre-onchain`. **Issue:** calibre #468 (P3, hardening).

## Why

The A4 submission-readiness audit (#454) found every public package suite green
except `sdk/`, which collects 0 tests (pytest exit 5). `sdk/` (`calibre_onchain`)
is the private↔public import boundary: the private calibre app imports it to call
`create_market` / `resolve` with the resolver key. It is the most-imported public
package and the only one without coverage. A smoke/contract suite hardens the seam
the judges read.

## SDK surface to cover (from `sdk/src/calibre_onchain/client.py`)

The SDK is intentionally narrow — `create`/`resolve` only. It exposes:

- `OnchainConfig` — frozen dataclass: `rpc_url`, `contract_address`, `resolver_key`,
  `chain_id`.
- `OnchainClient(config)` — constructs a web3 client + eth-account signer + a
  contract bound to the minimal `_ABI`. `resolver_address` property. Methods:
  - `create_market(chain_market_id)` → `createMarket(uint256)`, returns tx hash.
  - `resolve(chain_market_id, outcome)` → `resolve(uint256, uint8)`, returns tx hash.
    `outcome` is the points-side `"yes"`/`"no"` string, mapped to the contract enum
    **YES=1, NO=2** by `_outcome_to_enum`; `UNRESOLVED`/anything else raises `ValueError`.
- Module-level: `__version__`, `__all__`, `_ABI`, `_outcome_to_enum`, `_OUTCOME_*`.

**Boundary invariant (issue's headline ask):** the SDK's only settlement inputs are
`(chain_market_id, outcome)` — no LMSR/points/ledger surface. Asserted by reflecting
over the public API + the ABI input shapes.

**#465 note:** the merged `buy(quote, sig)` 2-arg change lives in `agent/`'s
`MarketClient`, **not** the SDK. The SDK has no `buy` helper (create/resolve only),
so there is no buy-call encoding to test here. Recorded as a Decision rather than
inventing a buy helper.

## Test design

Mirror `agent/tests/test_voucher.py`'s offline approach: web3/eth-account are real
imports, but no network. Construct the client via `OnchainClient.__new__(...)` and
inject a fake signer / fake contract `functions` recorder / fake `w3.eth`, so we
assert the exact `(method, args)` the client builds, the tx assembly
(`chainId`/`from`/`nonce`), and that the returned hash is the signed-tx hash — all
offline. `_outcome_to_enum` and the ABI are pure and tested directly.

## Files to touch

- `sdk/pyproject.toml` — add `[project.optional-dependencies] test = ["pytest>=8.0"]`
  (mirrors `agent/pyproject.toml`; `ranking/` has no extra but `agent/` does and the
  SDK needs pytest pinned the same way).
- `sdk/tests/__init__.py` — empty (match sibling layout if present) — **skip**; siblings
  have no `__init__.py` in `tests/`, so none here either.
- `sdk/tests/test_client.py` — the suite.

## Commit phases

1. `docs/plans/468-sdk-tests.md` (this file) — plan-first.
2. `sdk/pyproject.toml` — add the `test` optional-dependency group.
3. `sdk/tests/test_client.py` — the suite (config, outcome mapping, ABI shape,
   create/resolve call-shape + tx assembly, boundary invariant).

## Risks

- **No CI for Python packages** — only `contracts/` has a workflow. The suite is
  run-locally; verified from a fresh venv against a clean worktree.
- **web3 import at construction** — handled by `__new__` + fakes; the real network
  path is never exercised (no live RPC, by issue scope).
- If a test surfaces a real SDK bug, fix it in a separate named commit and note it.

## Test command

From a clean clone:

```
cd sdk
python3.12 -m venv .venv && .venv/bin/pip install -e ".[test]"
.venv/bin/python -m pytest tests/ -v
```
