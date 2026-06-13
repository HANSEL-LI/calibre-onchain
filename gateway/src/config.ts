/**
 * Gateway configuration — all values from the environment (public env contract
 * lives in the repo-root `.env.example`; this service ships no secrets).
 */
import { type Hex, isHex } from "viem";

export interface GatewayConfig {
  /** TCP port the CCIP-read HTTP server listens on. */
  port: number;
  /** Base URL of calibre's public API (Seam 2), e.g. https://app.hicalibre.gg/api/v1. */
  apiBase: string;
  /** Signing key for CCIP-read offchain responses (testnet placeholder by default). */
  signerKey: Hex;
  /**
   * Address of the on-chain offchain-resolver this gateway signs for. The ENS
   * booth designates the real resolver/testnet at the event; until then this is
   * an env placeholder. The signed `target` actually comes from the resolver's
   * `extraData` per request, so the gateway runs and is testable without it —
   * this value is used only for logging / the optional health echo.
   */
  resolverAddress: string;
}

function req(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const v = env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`missing required env var ${name}`);
  }
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const signerKey = req(env, "GATEWAY_SIGNER_KEY");
  if (!isHex(signerKey) || signerKey.length !== 66) {
    throw new Error("GATEWAY_SIGNER_KEY must be a 0x-prefixed 32-byte hex string");
  }
  return {
    port: Number.parseInt(req(env, "GATEWAY_PORT", "8080"), 10),
    apiBase: req(env, "CALIBRE_PUBLIC_API_BASE", "https://app.hicalibre.gg/api/v1").replace(
      /\/+$/,
      "",
    ),
    signerKey: signerKey as Hex,
    resolverAddress: env.GATEWAY_RESOLVER_ADDRESS ?? "0x0000000000000000000000000000000000000000",
  };
}
