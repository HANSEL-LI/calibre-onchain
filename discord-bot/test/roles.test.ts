import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LADDER_TIERS,
  MANAGED_ROLE_NAMES,
  TIER_STYLE,
  isTier,
  legacyRoleNameForTier,
  reconcileRoles,
  roleNameForTier,
  tierIndex,
} from "../src/roles.js";

test("seven ladder tiers in order", () => {
  assert.deepEqual(LADDER_TIERS, ["Static", "Hunch", "Read", "Edge", "Sharp", "Seer", "Oracle"]);
});

test("managed roles are exactly the per-tier roles (bare names)", () => {
  assert.equal(MANAGED_ROLE_NAMES.length, LADDER_TIERS.length);
  assert.deepEqual(MANAGED_ROLE_NAMES, [...LADDER_TIERS]);
});

test("isTier rejects non-ladder strings", () => {
  assert.equal(isTier("Oracle"), true);
  assert.equal(isTier("Unranked"), false);
  assert.equal(isTier("diamond"), false);
  assert.equal(isTier(""), false);
});

test("reconcile assigns the matching role to a member with none", () => {
  const d = reconcileRoles([], "Sharp");
  assert.deepEqual(d.add, ["Sharp"]);
  assert.deepEqual(d.remove, []);
});

test("reconcile is idempotent when already correct", () => {
  const d = reconcileRoles(["@everyone", "Sharp"], "Sharp");
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.remove, []);
});

test("reconcile swaps a stale tier role for the new one", () => {
  const d = reconcileRoles(["Read"], "Edge");
  assert.deepEqual(d.add, ["Edge"]);
  assert.deepEqual(d.remove, ["Read"]);
});

test("reconcile removes all managed roles for an unknown/null tier", () => {
  assert.deepEqual(reconcileRoles(["Seer"], null).remove, ["Seer"]);
  assert.deepEqual(reconcileRoles(["Seer"], null).add, []);
  // "Unranked" is not a ladder tier → no rank role.
  assert.deepEqual(reconcileRoles(["Seer"], "Unranked").remove, ["Seer"]);
});

test("reconcile never touches unmanaged roles", () => {
  const d = reconcileRoles(["@everyone", "Moderator", "Hunch"], "Oracle");
  assert.deepEqual(d.add, ["Oracle"]);
  assert.deepEqual(d.remove, ["Hunch"]);
  // Moderator / @everyone appear in neither list.
  assert.ok(!d.remove.includes("Moderator"));
  assert.ok(!d.add.includes("Moderator"));
});

test("reconcile removes a duplicate stale managed role too", () => {
  const d = reconcileRoles(["Read", "Edge"], "Edge");
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.remove, ["Read"]);
});

test("roleNameForTier is the bare tier label; legacy is the old calibre: prefix", () => {
  assert.equal(roleNameForTier("Oracle"), "Oracle");
  assert.equal(legacyRoleNameForTier("Oracle"), "calibre:Oracle");
});

test("every tier has a style; only the top three are hoisted", () => {
  for (const tier of LADDER_TIERS) {
    const s = TIER_STYLE[tier];
    assert.ok(s, `missing style for ${tier}`);
    assert.equal(typeof s.color, "number");
    assert.ok(s.color >= 0 && s.color <= 0xffffff, `${tier} colour out of range`);
    assert.ok(s.emoji.length > 0, `${tier} missing icon`);
  }
  const hoisted = LADDER_TIERS.filter((t) => TIER_STYLE[t].hoist);
  assert.deepEqual(hoisted, ["Sharp", "Seer", "Oracle"]);
});

test("tierIndex orders the ladder; -1 for null/unknown (promotion comparison)", () => {
  assert.equal(tierIndex("Static"), 0);
  assert.equal(tierIndex("Oracle"), 6);
  assert.ok(tierIndex("Seer") > tierIndex("Edge"), "higher tier has greater index");
  assert.equal(tierIndex(null), -1);
  assert.equal(tierIndex("Unranked"), -1);
  // A first-seen (null→Edge) reads as an increase; a demotion does not.
  assert.ok(tierIndex("Edge") > tierIndex(null));
  assert.ok(!(tierIndex("Read") > tierIndex("Seer")));
});
