"""Policy-violation webhook tests — faithful to Dynamic's documented contract.

The signature is computed the SAME way the real Dynamic sender does — HMAC-SHA256
over the exact raw request bytes, hex, prefixed ``sha256=`` (the documented scheme
in ``dynamic.xyz/docs/recipes/webhooks-signature-validation``) — so the fake is a
faithful sender, not a payload hand-crafted to match our own verifier. We assert:
a correctly-signed ``waas.policy.violation`` trips the kill path; a bad/missing
signature is rejected; a well-formed non-violation event is a no-op; and a
tampered body (valid sig for body A, deliver body B) is rejected.
"""
from __future__ import annotations

import hashlib
import hmac
import json

from calibre_agent.policy_webhook import (
    POLICY_VIOLATION_EVENT,
    SIGNATURE_HEADER,
    handle_webhook,
    is_policy_violation,
    verify_signature,
)

SECRET = "dyn_5LqRXtZsXit7Cjt9KktC8EGywoSkGSbGqtTud"


def _sign(raw_body: bytes, secret: str = SECRET) -> str:
    """Sign exactly as Dynamic documents: HMAC-SHA256 over the raw body, hex,
    prefixed ``sha256=``. This is the *sender* side — faithful, independent of the
    verifier under test."""
    digest = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def _violation_body(reason: str = "value_limit_exceeded") -> bytes:
    event = {
        "eventName": POLICY_VIOLATION_EVENT,
        "messageId": "msg-123",
        "eventId": "evt-1",
        "environmentId": "env-1",
        "timestamp": "2026-06-14T00:00:00Z",
        "data": {
            "reasonCode": reason,
            "deniedAddresses": ["0xbadc0ffee0000000000000000000000000000000"],
            "asset": {"symbol": "USDC"},
            "walletId": "wallet-xyz",
            "counterparties": ["0xbadc0ffee0000000000000000000000000000000"],
            "maxPerCallLimit": "1000000",
        },
    }
    return json.dumps(event).encode("utf-8")


def _benign_body() -> bytes:
    return json.dumps({
        "eventName": "wallet.created",
        "messageId": "msg-9",
        "data": {"walletId": "wallet-xyz"},
    }).encode("utf-8")


# ---- verify_signature -------------------------------------------------------
def test_verify_signature_accepts_correctly_signed_body():
    body = _violation_body()
    assert verify_signature(body, _sign(body), SECRET) is True


def test_verify_signature_rejects_wrong_secret():
    body = _violation_body()
    assert verify_signature(body, _sign(body, "other-secret"), SECRET) is False


def test_verify_signature_rejects_missing_header():
    body = _violation_body()
    assert verify_signature(body, None, SECRET) is False
    assert verify_signature(body, "", SECRET) is False


def test_verify_signature_rejects_when_no_secret_configured():
    body = _violation_body()
    assert verify_signature(body, _sign(body), "") is False


def test_verify_signature_rejects_unprefixed_hex():
    body = _violation_body()
    bare = _sign(body)[len("sha256="):]  # strip the documented prefix
    assert verify_signature(body, bare, SECRET) is False


def test_verify_signature_rejects_tampered_body():
    body_a = _violation_body("value_limit_exceeded")
    body_b = _violation_body("address_not_allowed")
    sig_for_a = _sign(body_a)
    # Valid signature for A, but B is delivered → reject.
    assert verify_signature(body_b, sig_for_a, SECRET) is False


# ---- is_policy_violation ----------------------------------------------------
def test_is_policy_violation_discriminates():
    assert is_policy_violation({"eventName": POLICY_VIOLATION_EVENT}) is True
    assert is_policy_violation({"eventName": "wallet.created"}) is False
    assert is_policy_violation({}) is False


# ---- handle_webhook: kill path ----------------------------------------------
def test_signed_violation_kills_agent(tmp_path):
    ks = tmp_path / "STOP"
    body = _violation_body("value_limit_exceeded")
    seen = []

    result = handle_webhook(
        body, _sign(body), secret=SECRET, kill_switch_file=str(ks),
        on_violation=seen.append,
    )

    assert result.status == "killed"
    assert result.event_name == POLICY_VIOLATION_EVENT
    assert result.reason_code == "value_limit_exceeded"
    # The existing kill mechanism: the kill-switch file now exists, so loop.run
    # halts new actions on the next tick.
    assert ks.exists()
    assert "value_limit_exceeded" in ks.read_text()
    # The parsed event reached the hook.
    assert len(seen) == 1 and seen[0]["eventName"] == POLICY_VIOLATION_EVENT


def test_allowlist_violation_also_kills(tmp_path):
    ks = tmp_path / "STOP"
    body = _violation_body("address_not_allowed")
    result = handle_webhook(body, _sign(body), secret=SECRET,
                            kill_switch_file=str(ks))
    assert result.status == "killed"
    assert ks.exists()


# ---- handle_webhook: reject path --------------------------------------------
def test_bad_signature_does_not_kill(tmp_path):
    ks = tmp_path / "STOP"
    body = _violation_body()
    seen = []
    result = handle_webhook(
        body, _sign(body, "wrong-secret"), secret=SECRET,
        kill_switch_file=str(ks), on_violation=seen.append,
    )
    assert result.status == "rejected"
    assert not ks.exists()  # agent NOT killed by an unauthenticated payload
    assert seen == []


def test_missing_signature_does_not_kill(tmp_path):
    ks = tmp_path / "STOP"
    body = _violation_body()
    result = handle_webhook(body, None, secret=SECRET, kill_switch_file=str(ks))
    assert result.status == "rejected"
    assert not ks.exists()


def test_signed_but_non_json_body_is_rejected(tmp_path):
    ks = tmp_path / "STOP"
    body = b"not json at all"
    result = handle_webhook(body, _sign(body), secret=SECRET,
                            kill_switch_file=str(ks))
    assert result.status == "rejected"
    assert not ks.exists()


# ---- handle_webhook: no-op path ---------------------------------------------
def test_signed_non_violation_event_is_noop(tmp_path):
    ks = tmp_path / "STOP"
    body = _benign_body()
    seen = []
    result = handle_webhook(
        body, _sign(body), secret=SECRET, kill_switch_file=str(ks),
        on_violation=seen.append,
    )
    assert result.status == "ignored"
    assert result.event_name == "wallet.created"
    assert not ks.exists()  # a benign event never halts the agent
    assert seen == []


def test_violation_with_no_kill_switch_file_still_reports(tmp_path):
    body = _violation_body()
    seen = []
    result = handle_webhook(
        body, _sign(body), secret=SECRET, kill_switch_file="",
        on_violation=seen.append,
    )
    # Still classified as a violation + hook fired, even without a file to write.
    assert result.status == "killed"
    assert len(seen) == 1
