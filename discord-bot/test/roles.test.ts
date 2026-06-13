import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LADDER_TIERS,
  MANAGED_ROLE_NAMES,
  isTier,
  reconcileRoles,
  roleNameForTier,
} from "../src/roles.js";

test("seven ladder tiers in order", () => {
  assert.deepEqual(LADDER_TIERS, ["Static", "Hunch", "Read", "Edge", "Sharp", "Seer", "Oracle"]);
});

test("managed roles are exactly the per-tier roles", () => {
  assert.equal(MANAGED_ROLE_NAMES.length, LADDER_TIERS.length);
  assert.deepEqual(MANAGED_ROLE_NAMES, LADDER_TIERS.map((t) => `calibre:${t}`));
});

test("isTier rejects non-ladder strings", () => {
  assert.equal(isTier("Oracle"), true);
  assert.equal(isTier("Unranked"), false);
  assert.equal(isTier("diamond"), false);
  assert.equal(isTier(""), false);
});

test("reconcile assigns the matching role to a member with none", () => {
  const d = reconcileRoles([], "Sharp");
  assert.deepEqual(d.add, ["calibre:Sharp"]);
  assert.deepEqual(d.remove, []);
});

test("reconcile is idempotent when already correct", () => {
  const d = reconcileRoles(["@everyone", "calibre:Sharp"], "Sharp");
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.remove, []);
});

test("reconcile swaps a stale tier role for the new one", () => {
  const d = reconcileRoles(["calibre:Read"], "Edge");
  assert.deepEqual(d.add, ["calibre:Edge"]);
  assert.deepEqual(d.remove, ["calibre:Read"]);
});

test("reconcile removes all managed roles for an unknown/null tier", () => {
  assert.deepEqual(reconcileRoles(["calibre:Seer"], null).remove, ["calibre:Seer"]);
  assert.deepEqual(reconcileRoles(["calibre:Seer"], null).add, []);
  // "Unranked" is not a ladder tier → no rank role.
  assert.deepEqual(reconcileRoles(["calibre:Seer"], "Unranked").remove, ["calibre:Seer"]);
});

test("reconcile never touches unmanaged roles", () => {
  const d = reconcileRoles(["@everyone", "Moderator", "calibre:Hunch"], "Oracle");
  assert.deepEqual(d.add, ["calibre:Oracle"]);
  assert.deepEqual(d.remove, ["calibre:Hunch"]);
  // Moderator / @everyone appear in neither list.
  assert.ok(!d.remove.includes("Moderator"));
  assert.ok(!d.add.includes("Moderator"));
});

test("reconcile removes a duplicate stale managed role too", () => {
  const d = reconcileRoles(["calibre:Read", "calibre:Edge"], "Edge");
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.remove, ["calibre:Read"]);
});

test("roleNameForTier is the documented 1:1 prefix map", () => {
  assert.equal(roleNameForTier("Oracle"), "calibre:Oracle");
});
