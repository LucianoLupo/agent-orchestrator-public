#!/bin/bash
# PreCompact hook — snapshot memory + git state before context compaction.
# Writes $AGENT_RUN_DIR/pre-compact-<timestamp>.md. Never blocks compaction.

set -u

INPUT=$(cat 2>/dev/null || true)

SESSION_ID=""
if command -v jq >/dev/null 2>&1 && [ -n "$INPUT" ]; then
  SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
fi

# If AGENT_RUN_DIR is unset or missing, nothing to do
if [ -z "${AGENT_RUN_DIR:-}" ] || [ ! -d "$AGENT_RUN_DIR" ]; then
  exit 0
fi

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
ISO_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
OUT_FILE="$AGENT_RUN_DIR/pre-compact-${TIMESTAMP}.md"

{
  echo "# Pre-Compaction Snapshot"
  echo ""
  echo "**Session:** ${SESSION_ID:-unknown}"
  echo "**Time:** ${ISO_TIME}"
  echo ""
  echo "## Memory State"
  echo ""
  MEM_PATH="${CLAUDE_PROJECT_DIR:-$PWD}/.claude/memory/MEMORY.md"
  if [ -f "$MEM_PATH" ]; then
    cat "$MEM_PATH"
  else
    echo "_No MEMORY.md found at ${MEM_PATH}_"
  fi
  echo ""
  echo "## Git State"
  echo ""
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo '### `git status --short`'
    echo ""
    echo '```'
    git status --short 2>/dev/null || true
    echo '```'
    echo ""
    echo '### `git diff --stat HEAD`'
    echo ""
    echo '```'
    git diff --stat HEAD 2>/dev/null || true
    echo '```'
  else
    echo "_Not a git repository_"
  fi
} > "$OUT_FILE" 2>/dev/null || true

exit 0
