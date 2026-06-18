// Mainnet CCIP-read smoke check for the ENS gateway (#642).
//
// Resolves a known opted-in subname through the real UniversalResolver →
// EIP-3668 OffchainLookup → this gateway path (viem getEnsAddress/getEnsText),
// and asserts the records that the stale-`dist/` bug silently dropped on
// 2026-06-14 (avatar/url/description were null for hours after a pull that
// rebuilt source but not the gitignored build). Exits non-zero on any miss so a
// partial/stale deploy fails loudly instead of serving null records.
//
// Network-only (public RPC), no creds. Run from gateway/ so viem resolves.
//   node smoke-records.mjs [name]
//   SMOKE_RPC_URL=https://my-rpc node smoke-records.mjs calibre.hicalibre.eth
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";

const name = process.argv[2] ?? "calibre.hicalibre.eth";
const RPC = process.env.SMOKE_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
// The address + the records most worth asserting: the ENS-standard trio that
// generic UIs render (and that the stale build dropped) plus rank as a canary
// for the gg.calibre.* namespace. A name with no opted-in profile fails here.
const REQUIRED_TEXT = ["avatar", "url", "description", "gg.calibre.rank"];
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const client = createPublicClient({ chain: mainnet, transport: http(RPC) });
const n = normalize(name);

const addr = await client.getEnsAddress({ name: n });
const texts = {};
for (const k of REQUIRED_TEXT) texts[k] = await client.getEnsText({ name: n, key: k });

console.log(`smoke ${name} (rpc ${RPC})`);
console.log(`  addr               = ${addr}`);
for (const k of REQUIRED_TEXT) console.log(`  ${k.padEnd(18)} = ${JSON.stringify(texts[k])}`);

const missing = [];
if (!addr || addr === ZERO_ADDR) missing.push("addr");
for (const k of REQUIRED_TEXT) if (!texts[k]) missing.push(k);

if (missing.length) {
  console.error(
    `✗ smoke FAILED — unresolved: ${missing.join(", ")} ` +
      `(stale gateway build? service down? name not opted-in?)`,
  );
  process.exit(1);
}
console.log("✓ smoke OK — gateway serves the full record set on mainnet");
