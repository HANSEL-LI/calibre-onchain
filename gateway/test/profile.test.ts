import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAN_TEXT_RECORD_KEYS,
  type ClanProfile,
  type PublicProfile,
  clanTextRecord,
  isClanRecordKey,
  textRecord,
} from "../src/profile.js";

// ── ENS-standard avatar / url / description records (#596) ──

const USER: PublicProfile = {
  display_name: "demo",
  tier: "Sharp",
  brier_skill: 0.42,
  roi: 1.5,
  pnl: 12345,
  wallet_address: "0xabc",
  discord_handle: "demo#1234",
  riot_id: "Demo#NA1",
  clan: "sharks",
  avatar: "https://app.hicalibre.gg/api/v1/profiles/demo/avatar.svg",
  url: "https://app.hicalibre.gg/#profile/demo",
  description: "Calibre forecaster — Sharp",
};

test("ENS-standard avatar/url/description map straight from the profile", () => {
  assert.equal(textRecord(USER, "avatar"), USER.avatar);
  assert.equal(textRecord(USER, "url"), USER.url);
  assert.equal(textRecord(USER, "description"), USER.description);
});

test("a null ENS-standard value resolves to the empty (unset) record", () => {
  const blank: PublicProfile = { ...USER, avatar: null, url: null, description: null };
  assert.equal(textRecord(blank, "avatar"), "");
  assert.equal(textRecord(blank, "url"), "");
  assert.equal(textRecord(blank, "description"), "");
});

const CLAN: ClanProfile = {
  clan: "sharks",
  size: 7,
  avg_rank: "Edge",
  brier_skill: 0.31,
  median_brier_skill: 0.28,
  roi: 0.42,
  top_member: "demo",
};

test("clan record keys are the four gg.calibre.clan.* aggregate keys", () => {
  assert.deepEqual(
    new Set(Object.keys(CLAN_TEXT_RECORD_KEYS)),
    new Set([
      "gg.calibre.clan.size",
      "gg.calibre.clan.avgrank",
      "gg.calibre.clan.brier",
      "gg.calibre.clan.roi",
    ]),
  );
});

test("isClanRecordKey distinguishes clan keys from user keys", () => {
  assert.equal(isClanRecordKey("gg.calibre.clan.size"), true);
  // The single user 'clan' key (a user's clan label) is NOT a clan-aggregate key.
  assert.equal(isClanRecordKey("gg.calibre.clan"), false);
  assert.equal(isClanRecordKey("gg.calibre.rank"), false);
});

test("clanTextRecord stringifies each field; null brier/roi → empty", () => {
  assert.equal(clanTextRecord(CLAN, "gg.calibre.clan.size"), "7");
  assert.equal(clanTextRecord(CLAN, "gg.calibre.clan.avgrank"), "Edge");
  assert.equal(clanTextRecord(CLAN, "gg.calibre.clan.brier"), "0.31");
  assert.equal(clanTextRecord(CLAN, "gg.calibre.clan.roi"), "0.42");

  const unscored: ClanProfile = { ...CLAN, brier_skill: null, roi: null };
  assert.equal(clanTextRecord(unscored, "gg.calibre.clan.brier"), "");
  assert.equal(clanTextRecord(unscored, "gg.calibre.clan.roi"), "");
  // size is always present even when unscored.
  assert.equal(clanTextRecord(unscored, "gg.calibre.clan.size"), "7");
});

test("an unknown clan key resolves to empty", () => {
  assert.equal(clanTextRecord(CLAN, "gg.calibre.clan.unknown"), "");
});
