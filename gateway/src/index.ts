/**
 * ENS CCIP-read (ENSIP-10 / EIP-3668) resolver gateway for `*.hicalibre.eth`.
 *
 * Serves `addr()` + `text()` records by reading calibre's public profile API
 * (Seam 2). It never touches the database — its sole data source is HTTP.
 *
 * EIP-3668 flow:
 *   on-chain resolver reverts OffchainLookup(sender, [gatewayUrl], callData, ...)
 *   client POSTs { sender, data } to this gateway
 *   gateway answers { data: abi.encode(bytes result, uint64 expires, bytes sig) }
 *   resolver callback verifies the signer + returns `result` to the client.
 *
 * Stateless by design: a crash is a redeploy. (W6.2, HANSEL-LI/Calibre#429.)
 */
import express, { type Request, type Response } from "express";
import { type Address, type Hex, getAddress, isHex } from "viem";
import { type GatewayConfig, loadConfig } from "./config.js";
import { createClanClient, createProfileClient } from "./profile.js";
import { handleResolve } from "./resolver.js";
import { signResult } from "./signing.js";

export function createApp(config: GatewayConfig) {
  const app = express();

  // CCIP-read clients call this gateway from the BROWSER (e.g. app.ens.domains,
  // wallets) via viem's offchain-lookup fetch, so a cross-origin POST needs CORS
  // — without it the browser blocks the response and every record reads empty,
  // even though server-side resolution works. A CCIP gateway is public, signed
  // infrastructure (the resolver verifies the signer, not the origin), so `*` is
  // correct here. Registered first so the OPTIONS preflight short-circuits before
  // body parsing. (#633)
  app.use((req: Request, res: Response, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Parse every body as JSON regardless of Content-Type: viem's `ccipRequest`
  // (the browser CCIP client) POSTs its `{ sender, data }` body WITHOUT an
  // `application/json` content-type, so the default content-type gate would skip
  // it and the handler would 400 on an empty body. (#633)
  app.use(express.json({ limit: "32kb", type: () => true }));

  const profiles = createProfileClient(config.apiBase);
  const clans = createClanClient(config.apiBase);

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, resolver: config.resolverAddress, apiBase: config.apiBase });
  });

  // EIP-3668 gateway endpoint. The POST body is { sender, data }; `sender` is
  // the resolver address that reverted (the signature `target`), `data` is the
  // resolve(name,data) calldata.
  const handler = async (req: Request, res: Response) => {
    try {
      const sender = (req.params.sender ?? req.body?.sender) as string | undefined;
      const data = (req.params.data ?? req.body?.data) as string | undefined;
      if (!sender || !data || !isHex(sender) || !isHex(data)) {
        res.status(400).json({ message: "sender and data must be 0x-hex" });
        return;
      }
      const target: Address = getAddress(sender);
      const { result } = await handleResolve(data as Hex, profiles, clans);
      const signed = await signResult(config.signerKey, target, data as Hex, result);
      res.json({ data: signed.data });
    } catch (err) {
      // 5xx → CCIP-read clients retry the next gateway URL.
      res.status(500).json({ message: (err as Error).message });
    }
  };

  // Both shapes per EIP-3668: POST {sender,data} (no {data} in URL) and the
  // GET {sender}/{data} template form.
  app.post("/", handler);
  app.get("/:sender/:data", handler);

  return app;
}

function main(): void {
  const config = loadConfig();
  const app = createApp(config);
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: "gateway_listening",
        port: config.port,
        apiBase: config.apiBase,
        resolver: config.resolverAddress,
      }),
    );
  });
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
