#!/bin/bash
# SessionStart hook — inject lightweight environment context as a system-reminder.
# Fires on startup | resume | clear | compact. Always exits 0.

set -u

INPUT=$(cat 2>/dev/null || true)

SOURCE="startup"
if command -v jq >/dev/null 2>&1 && [ -n "$INPUT" ]; then
  PARSED=$(echo "$INPUT" | jq -r '.source // empty' 2>/dev/null)
  [ -n "$PARSED" ] && SOURCE="$PARSED"
fi

DATE_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "Session context (source: ${SOURCE}):"
echo "- Date: ${DATE_ISO}"
echo "- cwd: ${PWD}"

if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "(detached)")
  echo "- Git branch: ${BRANCH}"
  echo "- Recent commits:"
  git log --oneline -3 2>/dev/null | sed 's/^/    /'
fi

if [ "$SOURCE" = "compact" ]; then
  echo ""
  echo "Context was just compacted. Check MEMORY.md for persistent state."
  MEM_PATH="${CLAUDE_PROJECT_DIR:-$PWD}/.claude/memory/MEMORY.md"
  if [ -f "$MEM_PATH" ]; then
    echo "Memory file: ${MEM_PATH}"
  fi
  if [ -n "${AGENT_RUN_DIR:-}" ] && [ -d "$AGENT_RUN_DIR" ]; then
    LATEST_BACKUP=$(ls -1t "$AGENT_RUN_DIR"/pre-compact-*.md 2>/dev/null | head -1)
    if [ -n "$LATEST_BACKUP" ]; then
      echo "Latest pre-compact backup: ${LATEST_BACKUP}"
    fi
  fi
fi

exit 0
