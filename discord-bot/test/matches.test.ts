import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type PublicMarket,
  type UpcomingMatch,
  channelNameFor,
  desiredChannels,
  isChannelForMatch,
  isManagedMatchChannelName,
  matchMarket,
  matchTag,
  oddsLine,
  pinnedMessageFor,
  reconcileChannels,
  slugifyTeam,
} from "../src/matches.js";

const API = "https://app.hicalibre.gg";

function mk(match_id: string, team1: string, team2: string, extra: Partial<UpcomingMatch> = {}): UpcomingMatch {
  return { match_id, team1, team2, status: "upcoming", ...extra };
}

test("slugifyTeam → channel-safe lowercase dashes", () => {
  assert.equal(slugifyTeam("NRG Esports"), "nrg-esports");
  assert.equal(slugifyTeam("100 Thieves!!"), "100-thieves");
  assert.equal(slugifyTeam("  Sentinels  "), "sentinels");
  assert.equal(slugifyTeam("FNATIC"), "fnatic");
});

test("matchTag is deterministic and 6 hex chars", () => {
  const a = matchTag("12345");
  assert.match(a, /^[0-9a-f]{6}$/);
  assert.equal(a, matchTag("12345"), "deterministic");
  assert.notEqual(matchTag("12345"), matchTag("54321"), "different ids → different tags");
});

test("channelNameFor is deterministic + idempotent + tagged", () => {
  const m = mk("999", "NRG", "Sentinels");
  const name = channelNameFor(m);
  assert.equal(name, channelNameFor(m), "idempotent");
  assert.match(name, /^nrg-vs-sentinels-[0-9a-f]{6}$/);
  assert.ok(isManagedMatchChannelName(name));
  assert.ok(isChannelForMatch(name, m));
});

test("same matchup, different match ids → distinct channel names", () => {
  const a = channelNameFor(mk("1", "NRG", "Sentinels"));
  const b = channelNameFor(mk("2", "NRG", "Sentinels"));
  assert.notEqual(a, b, "match-id tag disambiguates rematches");
});

test("channel name is clamped to Discord's 100-char limit", () => {
  const long = "x".repeat(120);
  const name = channelNameFor(mk("7", long, long));
  assert.ok(name.length <= 100, `len ${name.length}`);
});

test("isManagedMatchChannelName rejects human channels", () => {
  assert.equal(isManagedMatchChannelName("general"), false);
  assert.equal(isManagedMatchChannelName("rank-ups"), false);
  assert.equal(isManagedMatchChannelName("nrg-vs-sen-abc123"), true);
  assert.equal(isManagedMatchChannelName("nrg-vs-sen-xyz"), false, "tag must be 6 hex");
});

const MARKETS: PublicMarket[] = [
  { market_id: 5, question: "NRG vs Sentinels", team1: "NRG", team2: "Sentinels", price_yes: 6200 },
  { market_id: 6, question: "G2 vs LOUD", team1: "LOUD", team2: "G2", price_yes: 4500 },
];

test("matchMarket joins by unordered team pair", () => {
  assert.equal(matchMarket(mk("1", "NRG", "Sentinels"), MARKETS)?.market_id, 5);
  // Order-insensitive: match teams reversed relative to the market.
  assert.equal(matchMarket(mk("2", "G2", "LOUD"), MARKETS)?.market_id, 6);
});

test("matchMarket case-insensitive + null when no open market", () => {
  assert.equal(matchMarket(mk("3", "nrg", "SENTINELS"), MARKETS)?.market_id, 5);
  assert.equal(matchMarket(mk("4", "EG", "C9"), MARKETS), null);
});

test("oddsLine renders both sides from micro-cents", () => {
  assert.equal(oddsLine(MARKETS[0]), "NRG 62% · Sentinels 38%");
});

const reLink = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

test("pinnedMessageFor with a market carries odds + a match deep link", () => {
  const msg = pinnedMessageFor(mk("1", "NRG", "Sentinels", { event: "VCT" }), MARKETS[0], API);
  assert.match(msg, /NRG vs Sentinels/);
  assert.match(msg, /VCT/);
  assert.match(msg, /62%/);
  // Deep-links the match page, not the generic markets list.
  assert.match(msg, reLink(`${API}/#matches/1`));
  assert.doesNotMatch(msg, /#markets\b/);
});

test("pinnedMessageFor with no market says not open yet, still deep-links", () => {
  const msg = pinnedMessageFor(mk("9", "EG", "C9"), null, API);
  assert.match(msg, /No open market yet/);
  assert.match(msg, reLink(`${API}/#matches/9`));
});

test("pinnedMessageFor surfaces event · stage and date · time when present", () => {
  const msg = pinnedMessageFor(
    mk("670473", "LEVIATÁN", "Team Heretics", {
      event: "Valorant Masters London 2026",
      series: "Playoffs–Lower Round 1",
      date_group: "Sun, June 14, 2026",
      time: "4:00 PM",
    }),
    MARKETS[0],
    API,
  );
  assert.match(msg, /Valorant Masters London 2026 · Playoffs–Lower Round 1/);
  assert.match(msg, /Sun, June 14, 2026 · 4:00 PM/);
  assert.match(msg, reLink(`${API}/#matches/670473`));
});

test("pinnedMessageFor omits context lines a demo match lacks (no stray separators)", () => {
  const msg = pinnedMessageFor(mk("demo-replay-edg-fut-c1", "EDward Gaming", "FUT Esports"), null, API);
  assert.match(msg, /EDward Gaming vs FUT Esports/);
  assert.match(msg, reLink(`${API}/#matches/demo-replay-edg-fut-c1`));
  // No empty "· ·" / leading "· " from missing event/series/date/time.
  assert.doesNotMatch(msg, /· ·|\n ·|· \n/);
});

test("desiredChannels skips non-upcoming and team-less matches", () => {
  const matches: UpcomingMatch[] = [
    mk("1", "NRG", "Sentinels"),
    mk("2", "G2", "LOUD", { status: "live" }),
    mk("3", "", "C9"),
    mk("4", "EG", "C9", { status: undefined }),
  ];
  const d = desiredChannels(matches, MARKETS);
  assert.deepEqual(
    d.map((x) => x.match.match_id).sort(),
    ["1", "4"],
    "only upcoming (or status-less) with both team names",
  );
  // The NRG match resolves its market; the EG match has none.
  assert.equal(d.find((x) => x.match.match_id === "1")?.market?.market_id, 5);
  assert.equal(d.find((x) => x.match.match_id === "4")?.market, null);
});

test("reconcileChannels: create new, keep present, archive departed", () => {
  const desired = desiredChannels([mk("1", "NRG", "Sentinels"), mk("4", "EG", "C9")], MARKETS);
  const nrg = channelNameFor(mk("1", "NRG", "Sentinels"));
  const stale = channelNameFor(mk("99", "Old", "Match"));

  const plan = reconcileChannels(desired, [nrg, stale]);
  assert.deepEqual(plan.create.map((d) => d.match.match_id), ["4"], "EG is new");
  assert.deepEqual(plan.keep.map((d) => d.match.match_id), ["1"], "NRG already exists");
  assert.deepEqual(plan.archive, [stale], "the departed match channel is archived");
});

test("reconcileChannels is idempotent when fully converged", () => {
  const desired = desiredChannels([mk("1", "NRG", "Sentinels")], MARKETS);
  const name = channelNameFor(mk("1", "NRG", "Sentinels"));
  const plan = reconcileChannels(desired, [name]);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.archive, []);
  assert.deepEqual(plan.keep.map((d) => d.name), [name]);
});
