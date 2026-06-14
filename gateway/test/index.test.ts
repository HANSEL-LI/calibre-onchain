import { createServer } from "node:http";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { encodeFunctionData, namehash, toHex } from "viem";
import { packetToBytes } from "viem/ens";
import type { GatewayConfig } from "../src/config.js";
import { createApp } from "../src/index.js";

const RESOLVE_ABI = [
  {
    name: "resolve",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "bytes" }, { type: "bytes" }],
    outputs: [{ type: "bytes" }],
  },
] as const;
const ADDR_ABI = [
  {
    name: "addr",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
] as const;

// CCIP-read clients (app.ens.domains, wallets) call the gateway from the browser,
// so its responses must carry CORS headers or the browser blocks them and every
// record reads empty (#633). These tests pin that behaviour at the HTTP layer.
const config: GatewayConfig = {
  port: 0,
  apiBase: "http://127.0.0.1:1/api/v1", // unused on the /health + OPTIONS paths exercised here
  signerKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  resolverAddress: "0x129Ebe638F3dC10ce67b95AcBb2B3A27Dd7e8cb5",
};

const server = createApp(config).listen(0);
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
after(() => server.close());

test("OPTIONS preflight returns 204 with permissive CORS headers", async () => {
  const res = await fetch(`${base}/`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://app.ens.domains",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /content-type/i);
});

test("a normal response carries Access-Control-Allow-Origin so the browser can read it", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

// viem's ccipRequest POSTs its JSON body without an application/json content-type;
// the gateway must still parse it, or the handler 400s on an empty body (#633).
const upstream = createServer((_req, res) => {
  res.statusCode = 404; // every profile 404s → resolve to empty, but the body parsed
  res.end("{}");
}).listen(0);
const upstreamPort = (upstream.address() as AddressInfo).port;
const parseApp = createApp({ ...config, apiBase: `http://127.0.0.1:${upstreamPort}/api/v1` }).listen(0);
const parseBase = `http://127.0.0.1:${(parseApp.address() as AddressInfo).port}`;
after(() => {
  upstream.close();
  parseApp.close();
});

test("POST body parses without an application/json content-type (viem ccipRequest)", async () => {
  const dns = toHex(packetToBytes("demo.calibre.eth"));
  const node = namehash("demo.calibre.eth");
  const inner = encodeFunctionData({ abi: ADDR_ABI, functionName: "addr", args: [node] });
  const data = encodeFunctionData({ abi: RESOLVE_ABI, functionName: "resolve", args: [dns, inner] });
  const res = await fetch(`${parseBase}/`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ sender: config.resolverAddress, data }),
  });
  // Parsed → handler resolves (404 upstream → empty addr) → 200. A skipped parse
  // would 400 on missing sender/data — the exact bug app.ens.domains hit.
  assert.equal(res.status, 200);
});
