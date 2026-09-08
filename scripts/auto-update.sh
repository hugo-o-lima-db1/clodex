#!/usr/bin/env bash
# scripts/auto-update.sh — keep the locally-linked clodex fresh.
#
# Pulls feat/verboo-provider from origin (the fork), rebuilds dist, and logs.
# The global `clodex` is a pnpm link into this repo's dist/cli.js, so a rebuild
# is enough — no relink needed. Runs under a systemd user timer.
#
# Exit codes: 0 = up to date or updated cleanly; non-zero = needs attention.

set -euo pipefail

REPO="${CLODEX_REPO:-/home/hugolima/clodex}"
BRANCH="${CLODEX_BRANCH:-feat/verboo-provider}"
LOG="${CLODEX_LOG:-/home/hugolima/.local/state/clodex-auto-update.log}"

mkdir -p "$(dirname "$LOG")"

exec >>"$LOG" 2>&1
echo "=== $(date -Is) start ==="

cd "$REPO"

# Make pnpm available (the timer runs in a minimal env without ~/.zshrc).
export NVM_DIR="${NVM_DIR:-/home/hugolima/.nvm}"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" || true
export PNPM_HOME="${PNPM_HOME:-/home/hugolima/.local/share/pnpm}"
export PATH="$PNPM_HOME:$PATH"
export COREPACK_HOME="${COREPACK_HOME:-/home/hugolima/.cache/corepack}"

git fetch --quiet origin "$BRANCH"

OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse "origin/$BRANCH")

if [ "$OLD" = "$NEW" ]; then
  echo "already on $NEW; nothing to do"
  echo "=== $(date -Is) done (no-op) ==="
  exit 0
fi

echo "updating $OLD -> $NEW"
git checkout --quiet "$BRANCH"
git reset --hard --quiet "origin/$BRANCH"

# deps only change occasionally, but running install is cheap and safe.
pnpm install --frozen-lockfile 2>&1 | tail -3 || pnpm install 2>&1 | tail -3
pnpm build 2>&1 | tail -3

echo "=== $(date -Is) done (updated) ==="
