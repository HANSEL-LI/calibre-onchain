import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { ensNameFor, parseIdentity, verifySignature, SIGNATURE_HEADER } from "../src/identity.js";

const SECRET = "test-webhook-secret";

/** Canonical body exactly as calibre emits it (sorted keys, no whitespace). */
function body(discordId: string, displayName: string): Buffer {
  return Buffer.from(`{"discord_id":"${discordId}","display_name":"${displayName}"}`, "utf8");
}

function sign(secret: string, raw: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

test("SIGNATURE_HEADER matches the calibre emitter header (lowercased)", () => {
  assert.equal(SIGNATURE_HEADER, "x-calibre-signature");
});

test("verifySignature accepts a correct signature", () => {
  const raw = body("123", "alice");
  assert.equal(verifySignature(SECRET, raw, sign(SECRET, raw)), true);
});

test("verifySignature rejects a tampered body", () => {
  const raw = body("123", "alice");
  const sig = sign(SECRET, raw);
  assert.equal(verifySignature(SECRET, body("123", "mallory"), sig), false);
});

test("verifySignature rejects the wrong secret", () => {
  const raw = body("123", "alice");
  assert.equal(verifySignature("other-secret", raw, sign(SECRET, raw)), false);
});

test("verifySignature rejects missing / malformed headers", () => {
  const raw = body("123", "alice");
  assert.equal(verifySignature(SECRET, raw, undefined), false);
  assert.equal(verifySignature(SECRET, raw, "garbage"), false);
  assert.equal(verifySignature(SECRET, raw, "md5=abcd"), false);
  assert.equal(verifySignature(SECRET, raw, "sha256="), false);
  // An empty secret never verifies (ingest stays off when unconfigured).
  assert.equal(verifySignature("", raw, sign(SECRET, raw)), false);
});

test("CROSS-BOUNDARY VECTOR: matches calibre tests/test_accounts.py byte-for-byte", () => {
  // Pinned in BOTH repos. If the canonical-JSON encoding or HMAC drifts in
  // either repo, this assertion (and its calibre twin) fails.
  const raw = body("123456789012345678", "alice");
  assert.equal(
    raw.toString("utf8"),
    '{"discord_id":"123456789012345678","display_name":"alice"}',
  );
  const expected =
    "sha256=17b4e564881090b47a069536a2910a6d16a444629b706c44a81d898fa65621ed";
  assert.equal(sign(SECRET, raw), expected);
  assert.equal(verifySignature(SECRET, raw, expected), true);
});

test("parseIdentity returns the trimmed fields", () => {
  assert.deepEqual(parseIdentity(body("999", "bob")), { discordId: "999", displayName: "bob" });
  assert.deepEqual(
    parseIdentity(Buffer.from('{"discord_id":" 1 ","display_name":" c "}')),
    { discordId: "1", displayName: "c" },
  );
});

test("parseIdentity rejects malformed / incomplete bodies", () => {
  assert.equal(parseIdentity(Buffer.from("not json")), null);
  assert.equal(parseIdentity(Buffer.from("[]")), null);
  assert.equal(parseIdentity(Buffer.from('{"discord_id":"1"}')), null);
  assert.equal(parseIdentity(Buffer.from('{"display_name":"x"}')), null);
  assert.equal(parseIdentity(Buffer.from('{"discord_id":"","display_name":"x"}')), null);
  assert.equal(parseIdentity(Buffer.from('{"discord_id":1,"display_name":"x"}')), null);
});

test("ensNameFor maps a display name to a lowercased subname of the parent", () => {
  assert.equal(ensNameFor("Alice", "hicalibre.eth"), "alice.hicalibre.eth");
  // Tolerates a parent with stray leading/trailing dots.
  assert.equal(ensNameFor("bob", ".calibre.eth."), "bob.calibre.eth");
});
