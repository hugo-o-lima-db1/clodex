#!/usr/bin/env bash
# scripts/auto-patch.sh — keep the patch in step with Claude Code's own updates.
#
# Claude Code updates itself: a new build lands under versions/ at any hour, and
# the launcher starts the newest one. clodex's patch lives in the binary, so each
# of those updates arrives unpatched — the aliases and the model picker are gone
# until someone runs `clodex patch`. The launch check only offers to fix it, and
# answering that prompt is the chore this removes.
#
# Idempotent: it patches when the binary the launcher will start is not the one
# the manifest records, and does nothing otherwise. Safe to run from a path unit
# (on every change under versions/), from the daily updater, or by hand.
#
# Exit codes: 0 = already current or patched cleanly; non-zero = needs attention.

set -euo pipefail

REPO="${CLODEX_REPO:-/home/hugolima/clodex}"
VERSIONS_DIR="${CLAUDE_VERSIONS_DIR:-$HOME/.local/share/claude/versions}"
MANIFEST="${CLODEX_PATCH_STATE:-$HOME/.clodex/patch-state.json}"
LOG="${CLODEX_PATCH_LOG:-$HOME/.local/state/clodex-auto-patch.log}"
LOCK="${CLODEX_PATCH_LOCK:-$HOME/.local/state/clodex-auto-patch.lock}"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

# One patch at a time. The path unit can fire several times while a version is
# still being written, and two patchers on one binary is how a good install gets
# a half-written one.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "=== $(date -Is) another auto-patch holds the lock; skipping ==="
  exit 0
fi

echo "=== $(date -Is) start ==="

# The launcher starts the newest version, so that is the one worth patching.
TARGET=""
for candidate in "$VERSIONS_DIR"/*; do
  [ -f "$candidate" ] && [ -x "$candidate" ] && TARGET="$candidate"
done

if [ -z "$TARGET" ]; then
  echo "no Claude Code install under $VERSIONS_DIR; nothing to do"
  echo "=== $(date -Is) done (no-op) ==="
  exit 0
fi

# A version still being downloaded must not be patched. Waiting here rather than
# deferring is what makes this reliable: the directory watch fires while the file
# is still growing, and "try again later" has no later — nothing fires a second
# time once the download quietly finishes.
SETTLE_TRIES="${CLODEX_PATCH_SETTLE_TRIES:-60}"
previous=""
settled=""
for _ in $(seq "$SETTLE_TRIES"); do
  current=$(stat -c %s "$TARGET" 2>/dev/null || echo "")
  if [ -n "$current" ] && [ "$current" = "$previous" ]; then
    settled=yes
    break
  fi
  previous="$current"
  sleep 5
done

if [ -z "$settled" ]; then
  echo "$(basename "$TARGET") never stopped growing after $((SETTLE_TRIES * 5))s; leaving it alone"
  echo "=== $(date -Is) done (unsettled) ==="
  exit 1
fi

# The newest install can change while waiting — a second update landing during
# the wait makes the file measured no longer the one the launcher will start.
NEWEST=""
for candidate in "$VERSIONS_DIR"/*; do
  [ -f "$candidate" ] && [ -x "$candidate" ] && NEWEST="$candidate"
done
if [ "$NEWEST" != "$TARGET" ]; then
  echo "a newer install appeared while waiting ($(basename "$NEWEST")); re-running"
  exec "$0" "$@"
fi

PATCHED=$(python3 - "$MANIFEST" <<'PY' 2>/dev/null || true
import json, sys
try:
    print(json.load(open(sys.argv[1]))["binaryPath"])
except Exception:
    print("")
PY
)

if [ "$PATCHED" = "$TARGET" ]; then
  # Same install, but a rebuilt clodex changes the patch config hash and makes
  # the binary stale all the same. `clodex patch` compares that hash and exits
  # in seconds when there is nothing to do, so it — not this script — decides.
  echo "manifest already names $(basename "$TARGET"); letting clodex patch judge the config"
else
  echo "patching $(basename "$TARGET") (manifest had: ${PATCHED:-none})"
fi

# Make pnpm/node available: a systemd unit runs in a minimal env without ~/.zshrc.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" || true
export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
export PATH="$PNPM_HOME:$PATH"

# Name the target explicitly. Discovery honours CLODEX_CLAUDE_PATH, which a
# calling session may have pinned to the version it is running.
TWEAKCC_CC_INSTALLATION_PATH="$TARGET" node "$REPO/dist/cli.js" patch 2>&1 | tail -5

echo "=== $(date -Is) done ==="
