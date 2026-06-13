#!/usr/bin/env bash
# Live Arc-testnet settlement round-trip against the DEPLOYED CalibreMarket,
# the deployer wearing every role (resolver/signer/counterparty/buyer), amounts
# scaled small. Proves real on-chain USDC deltas + drain-to-zero solvency, and
# exercises the real EIP-712 voucher verify path end-to-end.
#
# Driven via `cast send` (real txs), NOT `forge script`: forge's local fork
# can't execute Arc's `isBlocklisted` precompile (0x1800…0001), so any
# transferFrom-bearing step (seed/buy/redeem) reverts in simulation. Real
# broadcast works. Reads contracts/.env. Operator one-off; not for CI.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")"
[ -f .env ] || { echo "✗ contracts/.env missing"; exit 1; }
set -a; . ./.env; set +a
RPC="https://rpc.testnet.arc.network"
: "${DEPLOYER_PRIVATE_KEY:?}"; : "${DEPLOYER_ADDRESS:?}"
: "${CALIBRE_MARKET_ADDRESS:?run deploy-testnet.sh first}"; : "${USDC_ADDRESS:?}"
MKT="$CALIBRE_MARKET_ADDRESS"; USDC="$USDC_ADDRESS"; ME="$DEPLOYER_ADDRESS"; K="$DEPLOYER_PRIVATE_KEY"
MID="${1:-8675309}"        # market id (override as arg to avoid MarketExists on re-run)
EXP=1900000000            # far-future voucher expiry

bal(){ cast call "$USDC" 'balanceOf(address)(uint256)' "$1" --rpc-url "$RPC"; }
send(){ cast send "$@" --private-key "$K" --rpc-url "$RPC" --json | grep -oE '"status":"0x[01]"' | head -1; }

echo "== LIVE round-trip on $MKT (actor $ME, marketId $MID) =="
echo "  actor  @start: $(bal "$ME")"
echo "  market @start: $(bal "$MKT")"

echo "  setVoucherSigner: $(send "$MKT" 'setVoucherSigner(address)' "$ME")"
echo "  setCounterparty:  $(send "$MKT" 'setCounterparty(address)' "$ME")"
echo "  createMarket:     $(send "$MKT" 'createMarket(uint256)' "$MID")"
echo "  approve:          $(send "$USDC" 'approve(address,uint256)' "$MKT" 100000000)"
echo "  seedInventory(3): $(send "$MKT" 'seedInventory(uint256,uint256)' "$MID" 3)"

NONCE=$(cast call "$MKT" 'nonces(address)(uint256)' "$ME" --rpc-url "$RPC")
Q="($MID,$ME,1,2,1000000,$NONCE,$EXP)"   # YES, size 2, maxCost 1 USDC
DIGEST=$(cast call "$MKT" 'hashQuote((uint256,address,uint8,uint256,uint256,uint256,uint256))(bytes32)' "$Q" --rpc-url "$RPC")
SIG=$(cast wallet sign --no-hash "$DIGEST" --private-key "$K")   # sign the raw EIP-712 digest
echo "  buy(2 YES):       $(send "$MKT" 'buy((uint256,address,uint8,uint256,uint256,uint256,uint256),bytes)' "$Q" "$SIG")"
echo "  resolve YES:      $(send "$MKT" 'resolve(uint256,uint8)' "$MID" 1)"
echo "  redeem:           $(send "$MKT" 'redeem(uint256)' "$MID")"

MKT_END=$(bal "$MKT")
echo "  actor  @end:  $(bal "$ME")  (≈start − gas; Arc pays gas in USDC)"
echo "  market @end:  $MKT_END"
[ "$MKT_END" = "0" ] && echo "✓ PASS: market drained to 0 — solvent" || { echo "✗ market did not drain (got $MKT_END)"; exit 2; }
