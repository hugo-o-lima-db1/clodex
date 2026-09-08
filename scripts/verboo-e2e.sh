#!/usr/bin/env bash
# scripts/verboo-e2e.sh — manual end-to-end validation for the Verboo provider.
#
# This script does NOT contain credentials. Set them in the environment:
#
#   VERBOO_BASE_URL=https://api.verboo.example/v1
#   VERBOO_API_KEY=sk-...
#
# It uses clodex's own patch/restore mechanism (no manual binary copies).
# If any step fails, it restores the pristine Claude Code before exiting.
#
# Usage:  VERBOO_BASE_URL=... VERBOO_API_KEY=... bash scripts/verboo-e2e.sh

set -euo pipefail

: "${VERBOO_BASE_URL:?VERBOO_BASE_URL is required}"
: "${VERBOO_API_KEY:?VERBOO_API_KEY is required}"

log() { printf '\n\033[1m==>\033[0m %s\n' "$*"; }

cleanup() {
  if [ -n "${PATCHED:-}" ]; then
    log "Restoring pristine Claude Code (clodex patch --restore)"
    clodex patch --restore || true
  fi
}
trap cleanup EXIT

log "Versions before"
claude --version
clodex --version

log "1. Add Verboo provider (non-interactive: pipe key + URL into the wizard)"
# The wizard reads from a TTY; for CI-style runs use expect/script or pre-seed
# the registry. Here we document the interactive path — run by a human:
printf 'BASE_URL=%s\nKEY=%s\n' "$VERBOO_BASE_URL" "${VERBOO_API_KEY:0:4}****"
echo "Run: clodex providers add verboo   # then paste URL and key when prompted"

log "2. List models — Verboo models should appear"
clodex models

log "3. Create a temporary alias"
clodex models --alias verboo-test=clodex:verboo:"$(clodex models --json 2>/dev/null | head -1 || echo glm-4.6)"

log "4. Apply patch"
clodex patch
PATCHED=1

log "5. Versions after"
claude --version
clodex --version

log "Manual validation checklist (open a NEW Claude Code session):"
cat <<'EOF'
  [ ] verboo-test model is recognised by Claude Code
  [ ] a simple chat call succeeds
  [ ] Bash / Read / Edit still work
  [ ] tool calling works
  [ ] Agent(model="verboo-test", ...) is accepted
  [ ] the request is served by Verboo (check clodex trace / debug log)
  [ ] a native Claude model (claude-sonnet-5) still goes to Anthropic
  [ ] switching between Claude and Verboo in the same install works
EOF

log "Done. Trap will restore pristine Claude Code on exit."
