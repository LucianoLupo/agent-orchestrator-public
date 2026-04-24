#!/bin/bash
# UserPromptSubmit hook — inject a JIT one-line reminder of mission and budget.
# Reads the agent's config.json (resolved via CLAUDE_PROJECT_DIR).
# Silent no-op on any failure; must never block the turn.

set -u

CONFIG_PATH="${CLAUDE_PROJECT_DIR:-$PWD}/config.json"

[ -f "$CONFIG_PATH" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

MISSION=$(jq -r '.mission // empty' "$CONFIG_PATH" 2>/dev/null | head -c 200)
MAX=$(jq -r '.maxTurns // empty' "$CONFIG_PATH" 2>/dev/null)

[ -z "$MISSION" ] && [ -z "$MAX" ] && exit 0

DATE_UTC=$(date -u +%Y-%m-%d)
echo "Mission: ${MISSION:-(unset)} | Budget: ${MAX:-?} turns | Date: ${DATE_UTC} UTC"
exit 0
