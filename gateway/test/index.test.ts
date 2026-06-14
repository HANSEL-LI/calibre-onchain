import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import type { GatewayConfig } from "../src/config.js";
import { createApp } from "../src/index.js";

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
