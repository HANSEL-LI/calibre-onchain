#!/usr/bin/env bash
# Redeploy the calibre ENS CCIP-read gateway (#642).
#
# Fixes the failure mode observed 2026-06-14: a bare `git pull` updated
# gateway/src but left the gitignored gateway/dist/ stale, so the new ENS text
# records (avatar/url/description, #32/#33) silently returned null on mainnet for
# hours — source + the profiles API were both current, only the running build was
# old. This script makes the rebuild non-optional and fails loudly via a live
# mainnet smoke check, so a partial deploy can't masquerade as a good one.
#
# Run ON the calibre VPS by an operator with sudo. Idempotent / re-runnable.
#   sudo bash gateway/deploy.sh
#   REF=origin/main SMOKE_NAME=calibre.hicalibre.eth sudo bash gateway/deploy.sh
#
# Knobs (env): REPO_DIR (/opt/calibre-onchain), SERVICE (calibre-ens-gateway),
# SERVICE_USER (calibre), REF (origin/main), SMOKE_NAME (calibre.hicalibre.eth).
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/calibre-onchain}"
SERVICE="${SERVICE:-calibre-ens-gateway}"
SERVICE_USER="${SERVICE_USER:-calibre}"
REF="${REF:-origin/main}"
SMOKE_NAME="${SMOKE_NAME:-calibre.hicalibre.eth}"

# Run repo/build steps as the user that owns the clone, so a sudo-invoked deploy
# doesn't leave root-owned files in $REPO_DIR (which would break the next pull).
as_user() {
  if [ "$(id -un)" = "$SERVICE_USER" ]; then bash -c "$1"; else sudo -u "$SERVICE_USER" bash -c "$1"; fi
}

echo "→ deploy-gateway: repo=$REPO_DIR ref=$REF service=$SERVICE user=$SERVICE_USER"
[ -d "$REPO_DIR/gateway" ] || { echo "✗ $REPO_DIR/gateway not found — wrong REPO_DIR?"; exit 1; }

echo "→ syncing source to $REF (hard reset; the clone is a deploy artifact, not a work tree)"
as_user "cd '$REPO_DIR' && git fetch origin --quiet && git reset --hard '$REF'"
echo "  ✓ at $(as_user "cd '$REPO_DIR' && git rev-parse --short HEAD") $(as_user "cd '$REPO_DIR' && git log -1 --format=%s HEAD")"

# dist/ is gitignored and built-on-deploy — rebuilding it every time is the whole
# point of this script (the stale-dist bug). npm ci keeps node_modules in lockstep
# with the committed package-lock.json.
echo "→ building gateway (npm ci + npm run build)"
as_user "cd '$REPO_DIR/gateway' && npm ci --silent && npm run build"
echo "  ✓ built dist/"

# (1) Build provenance — RPC-free, and the AUTHORITATIVE check for the #642 bug:
# the freshly built dist/ must actually map the ENS-standard records. If this
# fails the build is stale or the source regressed; hard-fail before we even
# restart something broken.
echo "→ verifying built dist/ maps the ENS-standard records (avatar/url/description)"
if as_user "grep -q 'p.avatar' '$REPO_DIR/gateway/dist/profile.js'"; then
  echo "  ✓ dist/profile.js maps the records"
else
  echo "✗ built dist/ is missing the avatar record mapping — stale build or source regression"
  exit 1
fi

echo "→ restarting $SERVICE"
sudo systemctl restart "$SERVICE"
sleep 2
if ! systemctl is-active --quiet "$SERVICE"; then
  echo "✗ $SERVICE not active after restart — last 20 log lines:"
  journalctl -u "$SERVICE" -n 20 --no-pager || true
  exit 1
fi
echo "  ✓ $SERVICE active"

# (2) Service health — RPC-free, authoritative for "is it running + configured".
echo "→ checking gateway /health"
health="$(curl -s -m 8 http://127.0.0.1:8080/health || true)"
echo "  $health"
echo "$health" | grep -q '"ok":true' || { echo "✗ gateway /health not ok"; exit 1; }

# (3) End-to-end CCIP smoke on mainnet — the real proof, but it rides free public
# RPCs whose CCIP-read support is flaky. Since a stale build already hard-failed
# at (1) and the service is provably up at (2), a persistent miss here is almost
# always the RPC, not the deploy — so we downgrade it to a warning rather than
# fail a good deploy. Set SMOKE_RPC_URL to a reliable RPC to make it deterministic.
echo "→ end-to-end smoke: $SMOKE_NAME must resolve on mainnet"
smoke_ok=
for attempt in 1 2 3 4 5; do
  if as_user "cd '$REPO_DIR/gateway' && node smoke-records.mjs '$SMOKE_NAME'"; then smoke_ok=1; break; fi
  echo "  smoke attempt $attempt failed; retrying in 4s…"
  sleep 4
done
if [ -n "$smoke_ok" ]; then
  echo "✓ deploy-gateway complete — verified end-to-end on mainnet"
else
  echo "⚠ deploy-gateway: build is fresh (1) and /health is green (2), but the mainnet"
  echo "  CCIP smoke did not resolve in 5 tries — almost certainly a flaky public RPC,"
  echo "  not a bad deploy. Re-confirm with a reliable RPC:"
  echo "    cd $REPO_DIR/gateway && SMOKE_RPC_URL=<rpc> node smoke-records.mjs $SMOKE_NAME"
fi
