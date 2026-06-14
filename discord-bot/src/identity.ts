/**
 * Verified identity ingest (#582).
 *
 * calibre owns the verified `discord_id <-> account <-> <name>.<ensParent>`
 * mapping (established via Discord OAuth) and PUSHES `(discord_id,
 * display_name)` to this bot so members get rank roles WITHOUT a user-run,
 * spoofable `/link`. The push is HMAC-SHA256-signed over the EXACT raw JSON
 * body; we verify byte-for-byte before trusting it.
 *
 * Cross-boundary contract (pinned by a vector in this repo's test AND in
 * calibre `tests/test_accounts.py`):
 *   body   = `{"discord_id":"<id>","display_name":"<name>"}` (calibre emits
 *            canonical JSON: sorted keys, no whitespace)
 *   header = `X-Calibre-Signature: sha256=<hex hmac_sha256(secret, rawBody)>`
 *
 * Rank is STILL read from ENS (this module never reads rank) — only identity
 * arrives here. The bot maps `display_name -> <display_name>.<ensParent>` and
 * resolves that name's `gg.calibre.rank` exactly as before.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

export const SIGNATURE_HEADER = "x-calibre-signature";

export interface IdentityPush {
  discordId: string;
  displayName: string;
}

/**
 * Verify `header` is a valid `sha256=<hex>` HMAC of `rawBody` under `secret`.
 * Constant-time compare; tolerant of a missing/garbage header (returns false).
 */
export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!secret || !header) return false;
  const [scheme, hex] = header.split("=", 2);
  if (scheme !== "sha256" || !hex) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let got: Buffer;
  try {
    got = Buffer.from(hex, "hex");
  } catch {
    return false;
  }
  // timingSafeEqual throws on length mismatch — guard first.
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

/**
 * Parse a verified push body into `{discordId, displayName}`. Returns null on
 * malformed JSON or missing/empty fields (caller responds 400). Trims the
 * display name; rejects anything without both fields.
 */
export function parseIdentity(rawBody: Buffer): IdentityPush | null {
  let obj: unknown;
  try {
    obj = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const { discord_id, display_name } = obj as Record<string, unknown>;
  if (typeof discord_id !== "string" || typeof display_name !== "string") return null;
  const discordId = discord_id.trim();
  const displayName = display_name.trim();
  if (!discordId || !displayName) return null;
  return { discordId, displayName };
}

/** Map a calibre `display_name` to the ENS name the bot resolves rank for. */
export function ensNameFor(displayName: string, ensParent: string): string {
  return `${displayName}.${ensParent.replace(/^\.+|\.+$/g, "")}`.toLowerCase();
}

/**
 * Start the identity-ingest HTTP server. POST `/identity` with a valid signed
 * body applies `onIdentity(discordId, ensName)` (typically: update the registry
 * + reconcile that member's role). 401 on a bad signature, 400 on a malformed
 * body, 404 on any other path/method. Returns the listening `Server` so the
 * caller can close it; never throws on a single bad request.
 */
export function createIdentityServer(opts: {
  secret: string;
  port: number;
  ensParent: string;
  onIdentity: (discordId: string, ensName: string) => Promise<void> | void;
}): Server {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/identity") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      void (async () => {
        const rawBody = Buffer.concat(chunks);
        if (!verifySignature(opts.secret, rawBody, req.headers[SIGNATURE_HEADER] as string | undefined)) {
          res.writeHead(401).end();
          return;
        }
        const identity = parseIdentity(rawBody);
        if (!identity) {
          res.writeHead(400).end();
          return;
        }
        try {
          await opts.onIdentity(identity.discordId, ensNameFor(identity.displayName, opts.ensParent));
          res.writeHead(204).end();
        } catch (err) {
          console.error("identity ingest apply failed", err);
          res.writeHead(500).end();
        }
      })();
    });
  });
  server.listen(opts.port);
  return server;
}
