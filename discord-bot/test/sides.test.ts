import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicMarket, UpcomingMatch } from "../src/matches.js";
import {
  type SidesResponse,
  activeMatch,
  backingRoleName,
  desiredSideAssignments,
  displayNameToMemberId,
  isBackingRoleName,
  reconcileSideRoles,
  teamColor,
} from "../src/sides.js";

function mk(match_id: string, team1: string, team2: string, extra: Partial<UpcomingMatch> = {}): UpcomingMatch {
  return { match_id, team1, team2, status: "upcoming", ...extra };
}

const MARKETS: PublicMarket[] = [
  { market_id: 5, question: "NRG vs Sentinels", team1: "NRG", team2: "Sentinels", price_yes: 6200 },
  { market_id: 6, question: "G2 vs LOUD", team1: "LOUD", team2: "G2", price_yes: 4500 },
];

function sidesFor(
  market_id: number,
  outcome_yes: string,
  outcome_no: string,
  holders: SidesResponse["holders"],
): SidesResponse {
  return {
    market_id,
    match_id: "m1",
    question: `${outcome_yes} vs ${outcome_no}`,
    outcome_yes,
    outcome_no,
    status: "open",
    holders,
  };
}

test("backingRoleName + isBackingRoleName round-trip", () => {
  assert.equal(backingRoleName("NRG"), "Backing NRG");
  assert.equal(backingRoleName("  Sentinels  "), "Backing Sentinels");
  assert.ok(isBackingRoleName("Backing NRG"));
  assert.equal(isBackingRoleName("Oracle"), false);
  assert.equal(isBackingRoleName("backing nrg"), false, "case-sensitive prefix");
});

test("teamColor is deterministic, stable per team, and in 0xRRGGBB range", () => {
  const a = teamColor("NRG");
  assert.equal(a, teamColor("NRG"), "deterministic");
  assert.equal(a, teamColor("  nrg  "), "trim + case-insensitive");
  assert.ok(a >= 0 && a <= 0xffffff, "in colour range");
  assert.notEqual(teamColor("NRG"), teamColor("Sentinels"), "different teams differ");
});

test("activeMatch picks the soonest upcoming match WITH an open market", () => {
  const matches: UpcomingMatch[] = [
    mk("1", "EG", "C9"), // upcoming but no market → skipped
    mk("2", "NRG", "Sentinels"), // first with a market → active
    mk("3", "G2", "LOUD"),
  ];
  const active = activeMatch(matches, MARKETS);
  assert.equal(active?.match.match_id, "2");
  assert.equal(active?.market.market_id, 5);
});

test("activeMatch skips non-upcoming + team-less, null when none qualifies", () => {
  assert.equal(
    activeMatch(
      [mk("1", "NRG", "Sentinels", { status: "live" }), mk("2", "", "C9")],
      MARKETS,
    ),
    null,
    "live + team-less don't qualify",
  );
  assert.equal(activeMatch([mk("9", "EG", "C9")], MARKETS), null, "no market → null");
});

test("displayNameToMemberId reverses the registry by leftmost ENS label", () => {
  const links = new Map<string, string>([
    ["discord-1", "alice.hicalibre.eth"],
    ["discord-2", "bob.hicalibre.eth"],
    ["discord-3", "carol.sharks.hicalibre.eth"], // clan-nested → leftmost label
  ]);
  const byName = displayNameToMemberId(links);
  assert.equal(byName.get("alice"), "discord-1");
  assert.equal(byName.get("bob"), "discord-2");
  assert.equal(byName.get("carol"), "discord-3");
  assert.equal(byName.get("nobody"), undefined);
});

test("desiredSideAssignments maps holders to Backing roles, skipping unlinked", () => {
  const byName = new Map<string, string>([
    ["alice", "discord-1"],
    ["bob", "discord-2"],
  ]);
  const sides = sidesFor(5, "NRG", "Sentinels", [
    { display_name: "alice", side: "yes" },
    { display_name: "bob", side: "no" },
    { display_name: "stranger", side: "yes" }, // not a linked member → skipped
  ]);
  const out = desiredSideAssignments(sides, byName);
  assert.deepEqual(out, [
    { memberId: "discord-1", roleName: "Backing NRG" },
    { memberId: "discord-2", roleName: "Backing Sentinels" },
  ]);
});

test("desiredSideAssignments joins display_name case-insensitively", () => {
  const byName = new Map<string, string>([["alice", "discord-1"]]);
  const sides = sidesFor(5, "NRG", "Sentinels", [{ display_name: "ALICE", side: "yes" }]);
  assert.deepEqual(desiredSideAssignments(sides, byName), [
    { memberId: "discord-1", roleName: "Backing NRG" },
  ]);
});

test("reconcileSideRoles assigns the wanted role to a member with none", () => {
  const d = reconcileSideRoles([], "Backing NRG");
  assert.deepEqual(d.add, ["Backing NRG"]);
  assert.deepEqual(d.remove, []);
});

test("reconcileSideRoles is idempotent when already correct", () => {
  const d = reconcileSideRoles(["@everyone", "Backing NRG"], "Backing NRG");
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.remove, []);
});

test("reconcileSideRoles swaps a stale side role for the new one", () => {
  const d = reconcileSideRoles(["Backing Sentinels"], "Backing NRG");
  assert.deepEqual(d.add, ["Backing NRG"]);
  assert.deepEqual(d.remove, ["Backing Sentinels"]);
});

test("reconcileSideRoles strips all side roles for a non-holder (want=null)", () => {
  const d = reconcileSideRoles(["Backing NRG"], null);
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.remove, ["Backing NRG"]);
});

test("reconcileSideRoles never touches unmanaged roles (incl. rank roles)", () => {
  // A rank role (Oracle) must NOT be stripped by the side-role reconcile —
  // the two role surfaces are independent.
  const d = reconcileSideRoles(["@everyone", "Oracle", "Backing Sentinels"], "Backing NRG");
  assert.deepEqual(d.add, ["Backing NRG"]);
  assert.deepEqual(d.remove, ["Backing Sentinels"]);
  assert.ok(!d.remove.includes("Oracle"), "rank role untouched");
});
