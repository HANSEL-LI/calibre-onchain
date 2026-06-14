# 619 — Dynamic MPC policies as on-chain guardrails (value limit + allowlist, pre-sign)

Closes #619 (calibre repo, ETHGlobal NYC 2026 umbrella #617). Lands in
**calibre-onchain** (`agent/`). Unblocked by #618 (PR #36) — the server wallet
(`DynamicServerWallet`) exists; this builds the policy-violation safety leg on top.

## What #619 is, split into owner-gated vs buildable

The issue attaches Dynamic **MPC policies** (per-token value/spend limit + a
contract allowlist of only `CalibreMarket` + USDC) to the bot's server wallet,
enforced in the TEE **pre-sign**, and subscribes to `waas.policy.violation`.

- **OWNER-GATED (not buildable headless):** creating the actual policy *rules* in
  the Dynamic **dashboard** (value limit + allowlist). That needs dashboard
  credentials. We instead **document** the exact rules to create in a repo doc so
  the owner applies them at the booth.
- **BUILDABLE HEADLESS (this PR):** a `waas.policy.violation` **webhook handler**
  that verifies the Dynamic webhook signature and, on a violation, logs it and
  **kills the agent** via the existing kill-switch mechanism. Rejects
  unsigned/badly-signed payloads.

## Faithful contract — verified against Dynamic public docs (no guessing)

Signature (recipe: `dynamic.xyz/docs/recipes/webhooks-signature-validation`):
- Header: **`x-dynamic-signature`**.
- Algorithm: **HMAC-SHA256** over the **raw JSON request body** (`JSON.stringify(payload)`).
- Format: hex digest **prefixed `sha256=`** (e.g. `sha256=9c1eade3…`).
- Compared with a **constant-time** equality check (`crypto.timingSafeEqual`).
- Secret: a per-webhook secret (e.g. `dyn_…`).

> Faithfulness note: the doc signs `JSON.stringify(payload)`. We HMAC the **raw
> request bytes** as received (never a re-serialized dict) — re-serializing could
> change key order/whitespace and break verification, exactly the "structure
> matters" caveat the doc calls out. The handler takes the raw body bytes.

Event (`dynamic.xyz/docs/.../webhooks/events`): top-level fields `eventName`
(`"{resource}.{action}"`), `messageId` (idempotency key), `eventId`, `webhookId`,
`environmentId`, `timestamp`, `data`. The violation event is
`eventName == "waas.policy.violation"` with `data`: `reasonCode`
(`address_denied` / `address_not_allowed` / `value_limit_exceeded` /
`security_risk_malicious` / `security_validation_failed`), `deniedAddresses`,
`asset`, `walletId`, `counterparties`, `maxPerCallLimit`.

## Kill mechanism — reuse the existing one, no parallel path

The agent already halts on a **kill-switch file** (`AGENT_KILL_SWITCH_FILE`):
`loop.run()` checks `_kill_switched()` each tick and stops new actions when the
file exists. The webhook handler kills by **writing that file** — the real,
already-wired stop, not a new mechanism (parsimony §7; defense-in-depth per the
issue's "app-level kill-switch already exists").

## Files to touch

- `agent/src/calibre_agent/policy_webhook.py` — **new**: `verify_signature()`
  (faithful HMAC-SHA256 over raw bytes, constant-time), `is_policy_violation()`,
  and `handle_webhook(raw_body, signature_header, *, secret, kill_switch_file,
  on_violation=None) -> Result` that verifies → on a violation logs + writes the
  kill-switch file. Pure-stdlib (`hmac`, `hashlib`, `json`); no web framework
  dependency (the agent has none — the handler is a framework-agnostic core a thin
  Flask/FastAPI/serverless shim calls, matching the SDK-isolation style of #618).
- `agent/src/calibre_agent/config.py` — add `dynamic_webhook_secret` (sensitive,
  selects the handler) read from `DYNAMIC_WEBHOOK_SECRET`; reuse `kill_switch_file`.
- `agent/src/calibre_agent/__init__.py` — re-export the new public symbols.
- `agent/.env.example` (repo-root `.env.example`) — `DYNAMIC_WEBHOOK_SECRET=` + note.
- `agent/README.md` — a "MPC policies + violation webhook" section: the
  **owner dashboard rules to create** (the documented owner-gated config) and the
  webhook handler/kill behavior.
- `agent/tests/test_policy_webhook.py` — **new**: faithful fake signed payload.

## Named commit phases

1. `docs(plan)`: this plan file (FIRST commit).
2. `feat(agent)`: `policy_webhook.py` (verify + handle + kill-switch write),
   config knob, `__init__` re-exports.
3. `test(agent)`: faithful-fake unit tests.
4. `docs(agent)`: README MPC-policies/webhook section (incl. the owner-gated
   dashboard rules) + `.env.example`.

## Faithful tests (`agent/tests/test_policy_webhook.py`)

A correctly-signed `waas.policy.violation` payload → kill path fires (kill-switch
file written, `on_violation` called). The signature is computed the SAME way the
real Dynamic sender does (HMAC-SHA256 over the exact raw bytes, `sha256=` hex) so
the fake is faithful, not hand-crafted to match our own verifier. A bad/missing
signature → rejected (no kill, no callback). A well-formed **non-violation** event
(e.g. `wallet.created`) with a *valid* signature → no-op (no kill). Tamper test:
valid signature for body A, deliver body B → rejected.

## Decisions (rationale up front)

- **Document the dashboard policy rules; do not attempt to create them headless.**
  Creating spend-limit/allowlist rules needs Dynamic dashboard credentials —
  owner/booth work. The repo doc states the exact rules (token = USDC, value
  limit, allowlist = `CalibreMarket` + USDC, allowlist mode evaluates *all*
  addresses in the call path so proxy + impl must both be listed per the docs).
- **Kill via the existing kill-switch file**, not a new stop path — reuses the
  already-tested halt and is the issue's "defense-in-depth on top of the existing
  kill-switch."
- **Verify over raw request bytes**, never a re-serialized dict — the doc warns
  payload structure must match byte-for-byte; re-encoding would falsely reject.
- **Framework-agnostic stdlib core**, no Flask/FastAPI dependency added — the
  agent ships zero web deps; the handler is a pure function a thin web shim or
  serverless function calls, mirroring how #618 isolated the SDK.
- **`reasonCode` is logged but not interpreted** — any documented violation code
  (value-limit or allowlist) trips the same kill; this is a blunt safety stop, not
  a policy engine.

## Risks

- Doc drift in the signature header/format. Mitigation: the verifier is one small
  function pinned to the documented `x-dynamic-signature` / `sha256=`-hex contract;
  the fake signs identically so a contract change is a one-line fix.

## Owner / booth-gated (left for the owner)

- Creating the actual MPC policy **rules in the Dynamic dashboard** (value limit +
  allowlist) — needs dashboard credentials. Documented in `agent/README.md`.
- The live success-criterion checkbox (a real tx exceeding the limit / hitting a
  non-allowlisted address gets rejected pre-sign and fires the webhook) needs the
  rules applied + a funded server wallet + a public webhook URL — booth work.

## Test command

```
cd <worktree>/agent && <calibre-checkout>/.venv/bin/python -m pytest \
  tests/test_policy_webhook.py tests/test_config_and_price.py
```
(No network, no real Dynamic account — the signed payload is produced with the
documented HMAC, then verified.)
