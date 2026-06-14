"""Dynamic MPC-policy violation webhook — the agent's pre-sign safety leg (#619).

Dynamic enforces MPC **policies** (per-token value/spend limits + a contract
allowlist) in the TEE *before* signing: a transaction that exceeds the value
limit or touches a non-allowlisted address is rejected pre-sign and Dynamic
emits a ``waas.policy.violation`` webhook. The *rules themselves* are created in
the Dynamic dashboard (owner/booth work — see ``README.md``); this module is the
**handler** for the violation event.

On a verified violation the handler logs it and **kills the agent** by writing
the existing kill-switch file (``AGENT_KILL_SWITCH_FILE`` /
``AgentConfig.kill_switch_file``): :func:`calibre_agent.loop.run` halts new
actions on the next tick when that file exists. We reuse that already-wired stop
rather than inventing a parallel kill path — this is defense-in-depth on top of
the app-level kill-switch, bounding a buggy/compromised agent at the signing
layer.

Signature verification is faithful to Dynamic's documented contract
(``dynamic.xyz/docs/recipes/webhooks-signature-validation``):

- Header ``x-dynamic-signature`` carries the signature.
- It is ``HMAC-SHA256`` over the **raw JSON request body**, hex-encoded and
  prefixed ``sha256=`` (e.g. ``sha256=9c1eade3…``).
- The secret is the per-webhook secret (``DYNAMIC_WEBHOOK_SECRET``).
- Comparison is constant-time.

We HMAC the **raw request bytes as received** (never a re-serialized dict): the
docs warn the payload structure must match byte-for-byte or verification fails,
so re-encoding would falsely reject. A thin web shim (Flask / FastAPI /
serverless) hands this function the raw body + the header; the handler itself is
framework-agnostic stdlib so the agent ships no web dependency.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
from dataclasses import dataclass
from typing import Callable, Optional

log = logging.getLogger("calibre_agent")

#: The HTTP header Dynamic puts the webhook signature in (documented).
SIGNATURE_HEADER = "x-dynamic-signature"

#: The event name for an MPC-policy violation (documented).
POLICY_VIOLATION_EVENT = "waas.policy.violation"

#: Documented violation reason codes (value-limit + allowlist + security). Logged
#: for context; any of them trips the same blunt kill — this is a safety stop,
#: not a policy engine.
KNOWN_REASON_CODES = (
    "address_denied",
    "address_not_allowed",
    "value_limit_exceeded",
    "security_risk_malicious",
    "security_validation_failed",
)


def verify_signature(raw_body: bytes, signature_header: Optional[str], secret: str) -> bool:
    """Return True iff ``signature_header`` is a valid Dynamic webhook signature
    for ``raw_body`` under ``secret``.

    Faithful to the documented scheme: ``HMAC-SHA256`` over the raw request body,
    hex-encoded, prefixed ``sha256=``, compared in constant time. A missing
    header, a missing/empty secret, or a malformed value returns False (reject).
    """
    if not secret:
        # No configured secret means we cannot authenticate the sender; refuse
        # rather than trust an unsigned-equivalent payload.
        return False
    if not signature_header:
        return False

    digest = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    expected = f"sha256={digest}"
    # Constant-time compare on the full "sha256=..." string (compare_digest is
    # itself timing-safe and tolerates length mismatch).
    return hmac.compare_digest(expected, signature_header)


def is_policy_violation(event: dict) -> bool:
    """True iff ``event`` is a ``waas.policy.violation`` webhook event."""
    return event.get("eventName") == POLICY_VIOLATION_EVENT


def _trip_kill_switch(kill_switch_file: str, event: dict) -> None:
    """Write the kill-switch file so :func:`loop.run` halts new actions next tick.

    The file's *existence* is the signal (loop checks ``os.path.exists``); the
    contents are a human-readable breadcrumb only. Addresses are pseudonymous
    on-chain personas (#224), so the denied addresses are safe to record here.
    """
    data = event.get("data") or {}
    reason = data.get("reasonCode", "unknown")
    note = (
        f"halted by waas.policy.violation reasonCode={reason} "
        f"messageId={event.get('messageId', '')}"
    )
    with open(kill_switch_file, "w", encoding="utf-8") as fh:
        fh.write(note + "\n")


@dataclass(frozen=True)
class WebhookResult:
    """Outcome of handling one webhook delivery.

    ``status`` is one of ``"rejected"`` (bad/missing signature — caller should
    return HTTP 401), ``"killed"`` (verified violation, agent halted — HTTP 200),
    or ``"ignored"`` (verified non-violation event, no-op — HTTP 200).
    """

    status: str
    event_name: Optional[str] = None
    reason_code: Optional[str] = None


def handle_webhook(
    raw_body: bytes,
    signature_header: Optional[str],
    *,
    secret: str,
    kill_switch_file: str,
    on_violation: Optional[Callable[[dict], None]] = None,
) -> WebhookResult:
    """Verify a Dynamic webhook delivery and, on a policy violation, kill the agent.

    ``raw_body`` is the exact request bytes (do not re-serialize). On an invalid
    or missing signature returns ``status="rejected"`` and does nothing. On a
    verified ``waas.policy.violation`` it logs the violation, writes
    ``kill_switch_file`` to halt the loop, optionally calls ``on_violation`` (the
    parsed event), and returns ``status="killed"``. Any other verified event is a
    no-op (``status="ignored"``).
    """
    if not verify_signature(raw_body, signature_header, secret):
        log.warning("webhook rejected reason=bad_signature header_present=%s",
                    bool(signature_header))
        return WebhookResult(status="rejected")

    try:
        event = json.loads(raw_body)
    except (ValueError, TypeError):
        # Signature verified but body isn't JSON — treat as a reject; a valid
        # Dynamic delivery is always a JSON object.
        log.warning("webhook rejected reason=non_json_body")
        return WebhookResult(status="rejected")
    if not isinstance(event, dict):
        log.warning("webhook rejected reason=non_object_body")
        return WebhookResult(status="rejected")

    event_name = event.get("eventName")
    if not is_policy_violation(event):
        log.info("webhook ignored event=%s", event_name)
        return WebhookResult(status="ignored", event_name=event_name)

    data = event.get("data") or {}
    reason = data.get("reasonCode")
    log.error(
        "policy violation killing agent event=%s reasonCode=%s "
        "deniedAddresses=%s asset=%s walletId=%s messageId=%s",
        event_name, reason, data.get("deniedAddresses"), data.get("asset"),
        data.get("walletId"), event.get("messageId"),
    )

    if kill_switch_file:
        _trip_kill_switch(kill_switch_file, event)
    else:
        # No kill-switch file configured: still surface the violation loudly. The
        # on_violation hook can stop the process another way.
        log.error("policy violation but no kill_switch_file configured; "
                  "agent NOT halted via file")

    if on_violation is not None:
        on_violation(event)

    return WebhookResult(status="killed", event_name=event_name, reason_code=reason)
