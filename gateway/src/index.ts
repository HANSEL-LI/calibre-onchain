/**
 * ENS CCIP-read (ENSIP-10) resolver gateway for `*.calibre.eth`.
 *
 * W0 SCAFFOLD — placeholder entrypoint only. The gateway will resolve subnames
 * to `addr()` + `text()` records by reading the calibre public profile API
 * (Seam 2): `addr()` <- wallet_address, `text("gg.calibre.rank")` <- tier,
 * `text("com.discord")` <- discord_handle, etc. It never touches the database.
 * Implementation lands in W6.2.
 */
export function main(): void {
  throw new Error("calibre-onchain gateway: not implemented (W0 scaffold; see W6.2)");
}
