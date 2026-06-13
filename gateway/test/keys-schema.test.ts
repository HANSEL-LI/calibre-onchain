import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TEXT_RECORD_KEYS } from "../src/profile.js";

/**
 * Cross-language drift guard (#445). The canonical gg.calibre.* key set lives in
 * the Python `ranking/` lib (`calibre_ranking.TEXT_KEYS`), which this TypeScript
 * gateway can't import. The ranking package emits that set to a committed
 * `ranking/keys.json` fixture (guarded against keys.py drift by a pytest case);
 * here we assert this gateway's `TEXT_RECORD_KEYS` answers exactly that set, so a
 * key added/renamed on either side fails a test.
 *
 * Only the key SET is the shared contract — the map values are gateway-specific
 * field readers and are intentionally not part of it.
 */
const fixturePath = fileURLToPath(new URL("../../ranking/keys.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { text_keys: string[] };

test("TEXT_RECORD_KEYS matches the canonical ranking/keys.json key set", () => {
  const served = new Set(Object.keys(TEXT_RECORD_KEYS));
  const canonical = new Set(fixture.text_keys);

  const missingFromGateway = [...canonical].filter((k) => !served.has(k));
  const extraInGateway = [...served].filter((k) => !canonical.has(k));

  assert.deepEqual(
    missingFromGateway,
    [],
    `gateway TEXT_RECORD_KEYS is missing canonical key(s): ${missingFromGateway.join(", ")}`,
  );
  assert.deepEqual(
    extraInGateway,
    [],
    `gateway TEXT_RECORD_KEYS has key(s) absent from ranking/keys.json: ${extraInGateway.join(", ")}`,
  );
});
