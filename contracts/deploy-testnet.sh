#!/usr/bin/env bash
# One-shot Arc-testnet deploy for CalibreMarket (A6, #456). Idempotent-ish:
# fail-fast preflight, then deploy, then write CALIBRE_MARKET_ADDRESS back to .env.
# Re-run after funding the deployer + setting USDC_ADDRESS. NOT committed by default.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")"                      # contracts/
RPC="https://rpc.testnet.arc.network"

[ -f .env ] || { echo "✗ contracts/.env missing"; exit 1; }
set -a; . ./.env; set +a

command -v forge >/dev/null || { echo "✗ forge not on PATH"; exit 1; }
: "${DEPLOYER_PRIVATE_KEY:?✗ DEPLOYER_PRIVATE_KEY unset in .env}"
: "${DEPLOYER_ADDRESS:?✗ DEPLOYER_ADDRESS unset in .env}"

echo "→ preflight"
# (1) USDC address present
if [ -z "${USDC_ADDRESS:-}" ]; then
  echo "✗ BLOCKED: USDC_ADDRESS not set in contracts/.env — get it from https://faucet.circle.com"; exit 2
fi
# (2) deployer has gas
BAL="$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC")"
if [ "$BAL" = "0" ]; then
  echo "✗ BLOCKED: deployer $DEPLOYER_ADDRESS has 0 gas — fund it with Arc-testnet gas first"; exit 3
fi
echo "  ✓ deployer gas balance: $BAL"
# (3) USDC looks like a 6-dec ERC-20 on this chain
DEC="$(cast call "$USDC_ADDRESS" 'decimals()(uint8)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
echo "  USDC $USDC_ADDRESS decimals=$DEC (expect 6)"
[ "$DEC" = "6" ] || echo "  ⚠ USDC decimals != 6 — double-check the token address before continuing"

RESOLVER_ADDRESS="${RESOLVER_ADDRESS:-$DEPLOYER_ADDRESS}"
export USDC_ADDRESS RESOLVER_ADDRESS

echo "→ deploying CalibreMarket (usdc=$USDC_ADDRESS resolver=$RESOLVER_ADDRESS)"
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY" -vvv 2>&1 | tee /tmp/calibre-deploy.log

MARKET="$(grep -oiE 'CalibreMarket deployed:?[[:space:]]*0x[a-fA-F0-9]{40}' /tmp/calibre-deploy.log \
          | grep -oE '0x[a-fA-F0-9]{40}' | head -1)"
if [ -z "$MARKET" ]; then echo "✗ could not parse deployed address from log"; exit 4; fi

# write CALIBRE_MARKET_ADDRESS back to .env (replace the placeholder line)
if grep -q '^CALIBRE_MARKET_ADDRESS=' .env; then
  sed -i.bak "s|^CALIBRE_MARKET_ADDRESS=.*|CALIBRE_MARKET_ADDRESS=$MARKET|" .env && rm -f .env.bak
else
  echo "CALIBRE_MARKET_ADDRESS=$MARKET" >> .env
fi
echo "✓ CalibreMarket deployed: $MARKET"
echo "  written to contracts/.env as CALIBRE_MARKET_ADDRESS"
echo "  next: set VOUCHER_SIGNER_ADDR + COUNTERPARTY_ADDR, then run the §3 configure steps"
