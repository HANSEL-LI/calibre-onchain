import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAN_ROLE_PREFIX,
  clanRoleName,
  isManagedClanRole,
  reconcileClanRole,
} from "../src/clans.js";

test("clanRoleName prefixes the label and trims", () => {
  assert.equal(clanRoleName("Sharks"), "clan:Sharks");
  assert.equal(clanRoleName("  Sentinels  "), "clan:Sentinels");
  assert.ok(clanRoleName("x").startsWith(CLAN_ROLE_PREFIX));
});

test("clanRoleName clamps to Discord's 100-char limit", () => {
  const name = clanRoleName("z".repeat(120));
  assert.ok(name.length <= 100, `len ${name.length}`);
});

test("isManagedClanRole matches only prefixed roles", () => {
  assert.equal(isManagedClanRole("clan:Sharks"), true);
  assert.equal(isManagedClanRole("Sharks"), false);
  assert.equal(isManagedClanRole("Oracle"), false); // a rank role is not a clan role
  assert.equal(isManagedClanRole("Moderator"), false);
});

test("reconcile assigns the clan role to a member with none", () => {
  const d = reconcileClanRole([], "Sharks");
  assert.deepEqual(d.add, ["clan:Sharks"]);
  assert.deepEqual(d.remove, []);
});

test("reconcile is idempotent when already correct", () => {
  const d = reconcileClanRole(["@everyone", "Oracle", "clan:Sharks"], "Sharks");
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.remove, []);
});

test("reconcile swaps a stale clan role for the new one", () => {
  const d = reconcileClanRole(["clan:Sharks"], "Wolves");
  assert.deepEqual(d.add, ["clan:Wolves"]);
  assert.deepEqual(d.remove, ["clan:Sharks"]);
});

test("reconcile removes all managed clan roles for a null/empty clan", () => {
  assert.deepEqual(reconcileClanRole(["clan:Sharks"], null).remove, ["clan:Sharks"]);
  assert.deepEqual(reconcileClanRole(["clan:Sharks"], null).add, []);
  assert.deepEqual(reconcileClanRole(["clan:Sharks"], "   ").remove, ["clan:Sharks"]);
});

test("reconcile never touches rank roles or human roles", () => {
  const d = reconcileClanRole(["@everyone", "Oracle", "Moderator", "clan:Sharks"], "Wolves");
  assert.deepEqual(d.add, ["clan:Wolves"]);
  assert.deepEqual(d.remove, ["clan:Sharks"]);
  for (const list of [d.add, d.remove]) {
    assert.ok(!list.includes("Oracle"));
    assert.ok(!list.includes("Moderator"));
    assert.ok(!list.includes("@everyone"));
  }
});

test("reconcile drops a duplicate stale managed clan role too", () => {
  const d = reconcileClanRole(["clan:Sharks", "clan:Old"], "Sharks");
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.remove, ["clan:Old"]);
});
