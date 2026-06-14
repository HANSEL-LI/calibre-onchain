# 618 — Dynamic: provision the MM bot as a real Dynamic server wallet (MPC)

Closes #618 (calibre repo). Lands in **calibre-onchain** (`agent/`).

## Contract finding (STEP 0 — resolved before writing client code)

The issue body's vocabulary (`@dynamic-labs-wallet/node-evm`, `authenticateApiToken`,
`createWalletAccount({ thresholdSignatureScheme })`, `externalServerKeyShares`,
`walletMetadata`) is the **Node SDK's** surface. The agent is Python. The prompt
flagged the open question: is the MPC TSS create+sign flow faithfully buildable in
**Python** from public docs, or Node-only / undocumented?

**Answer: it IS faithfully buildable in Python from public docs.** Dynamic ships a
documented, real, server-side **Python SDK** for MPC server wallets:

- Package: **`dynamic-wallet-sdk`** (PyPI, v0.6.2 verified live, `requires-python >=3.11`,
  summary "Dynamic MPC Wallet SDK for Python — create and manage multi-party
  computation wallets for EVM and Solana").
- Docs (public, no auth): `dynamic.xyz/docs/python/quickstart`,
  `.../python/evm/create-wallet`, `.../python/evm/sign-transactions`,
  `.../python/evm/delegated-access`.

Documented contract (verbatim from the docs):

```python
from dynamic_wallet_sdk import DynamicEvmWalletClient, ThresholdSignatureScheme

async with DynamicEvmWalletClient(env_id) as client:        # env id to ctor
    await client.authenticate_api_token(api_token)           # API token
    props = await client.create_wallet_account(              # -> WalletProperties
        threshold_signature_scheme=ThresholdSignatureScheme.TWO_OF_TWO,
        password=password,                                   # encrypts + backs up shares to Dynamic
    )
    props.account_address, props.wallet_id                   # the non-sensitive fields we persist
    tx_hash = await client.send_transaction(address=..., tx=tx, rpc_url=...)  # signs+broadcasts (legacy tx)
    sig_hex = await client.sign_transaction(address=..., tx=tx)              # 65-byte ECDSA sig only
```

### Two key contract facts that drive the design (do not guess past these)

1. **The Python SDK's key-share model is NOT the Node `externalServerKeyShares`
   raw-stateless model.** The documented Python create flow takes a `password` that
   "encrypts your key shares and backs them up to Dynamic at keygen time" — Dynamic
   stores the encrypted shares; the caller holds the **`password`** (and, in the
   delegated-access pattern, an encrypted `key_share` + `wallet_api_key`). So the
   sensitive material we must vault in Python is the **password / wallet_api_key /
   key_share**, not a `externalServerKeyShares` blob. The issue's storage invariant
   ("never logged, never a plaintext DB column") still applies verbatim — we hold it
   through a secret-ref / vault abstraction. We do **not** invent a Python
   `externalServerKeyShares` param the SDK does not document.
2. **`send_transaction` signs AND broadcasts (owns the RPC), returning a tx hash;
   `sign_transaction` returns only a 65-byte ECDSA signature, not serialized raw
   tx bytes.** The existing `Signer` protocol returns raw bytes and `MarketClient`
   broadcasts. Reconstructing serialized raw bytes from a bare 65-byte sig is not a
   documented SDK capability, so we extend the signer seam with an **optional
   `send_transaction(tx) -> tx_hash`** capability that a broadcasting signer (Dynamic)
   implements; `MarketClient._send` prefers it when present and otherwise falls back
   to the existing sign→`send_raw_transaction` path (`LocalKeySigner`). EIP-1559
   fields are unsupported by the SDK (legacy `gasPrice` only) — documented in code.

## Files to touch

- `agent/src/calibre_agent/signer.py` — replace the generic REST `DynamicServerWallet`
  with a real `dynamic-wallet-sdk`-backed `DynamicServerWallet`; add the optional
  `BroadcastingSigner` protocol method; add a tiny `SecretRef` vault-abstraction
  seam for the sensitive material.
- `agent/src/calibre_agent/config.py` — add the real config knobs (threshold scheme,
  password/secret-ref source, persisted wallet metadata: `dynamic_wallet_id` /
  `dynamic_account_address`); keep `uses_server_wallet()`.
- `agent/src/calibre_agent/contract.py` — `_send` prefers a broadcasting signer.
- `agent/src/calibre_agent/__init__.py` — re-export the new symbols.
- `agent/README.md` — correct the signer section to the real Python SDK contract +
  the password/vault storage decision + the `backUpToDynamic` backup note.
- `agent/.env.example` (repo-root `.env.example` if present) — the real env contract.
- `agent/pyproject.toml` — add `dynamic-wallet-sdk` as an optional `server-wallet`
  extra (kept optional so the testnet/local artifact installs without it).
- `agent/tests/test_signer.py` — new faithful-fake unit tests (mirror
  `app/components/wallet-connect.test.js`: fake the SDK to its real documented
  contract; assert provisioning persists only non-sensitive metadata, signing
  delegates with the secret never logged, selection gating, local fallback).

## Named commit phases

1. `docs(plan)`: this plan file (FIRST commit).
2. `feat(signer)`: real `dynamic-wallet-sdk`-backed `DynamicServerWallet` + `SecretRef`
   vault seam + optional broadcasting-signer protocol; config knobs; contract `_send`
   prefers a broadcasting signer; `__init__` re-exports.
3. `test(signer)`: faithful-fake unit tests under `agent/tests/test_signer.py`.
4. `docs(agent)`: README signer section + `.env.example` corrected to the real contract.

## Decisions

- **Use the documented Python SDK (`dynamic-wallet-sdk`), not a hand-rolled REST
  client.** The MPC TSS create+sign flow is only faithfully expressible through the
  SDK; there is no separately-documented public REST endpoint for the MPC sign flow
  in the docs surface. Building on the SDK is the faithful path.
- **Vault the `password` (and any delegated `key_share`/`wallet_api_key`) via a
  `SecretRef` indirection, never a plaintext attribute we log.** `__repr__` redacts;
  the secret is fetched lazily at use. Persist only `wallet_id` + `account_address`
  (non-sensitive) — satisfies "externalServerKeyShares never logged / never a
  plaintext DB column" mapped onto the Python contract.
- **`backUpToDynamic`: rely on Dynamic's password-encrypted backup** (the Python
  SDK default with a `password`) rather than self-custodying raw shares — losing the
  password loses the wallet, documented in the README backup note. This is the
  defensible default for a demo MM bot; self-custody of raw shares is a Node-only
  path the Python SDK does not expose.
- **Extend the signer seam with an optional `send_transaction(tx)->hash`** rather
  than forcing raw-bytes reassembly the SDK doesn't document.
- **Keep the SDK import lazy + the dependency an optional extra** so the testnet
  artifact (LocalKeySigner) installs and tests run with no Dynamic dependency.

## Owner / booth-gated (left for the owner)

- The live-testnet-buy success-criterion checkbox requires real `DYNAMIC_API_TOKEN`
  + `DYNAMIC_ENVIRONMENT_ID`, a provisioned + funded Arc server wallet, and a KMS
  binding for the `SecretRef` — all owner credentials. Tests prove the path with a
  faithful fake; the live buy stays owner/booth work.

## Risks

- SDK minor-version drift in param names. Mitigation: lazy import, isolate all SDK
  calls in `DynamicServerWallet`, fakes pinned to the documented v0.6.x contract.

## Test command

```
cd <worktree>/agent && <calibre-checkout>/.venv/bin/python -m pytest tests/test_signer.py tests/test_config_and_price.py
```
(SDK calls are faked; no network, no real Dynamic account needed.)
