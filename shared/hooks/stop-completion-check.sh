#!/bin/bash
# Stop Hook — Deterministic gate only (output file existence).
# Semantic completion check moved to a Haiku prompt hook in settings.json.

INPUT=$(cat)

# Prevent infinite loops — if we already blocked once, allow
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
[ "$STOP_ACTIVE" = "true" ] && exit 0

# Check required output file exists (HOOK-02)
if [ -n "$AGENT_OUTPUT_FILE" ] && [ ! -f "$AGENT_OUTPUT_FILE" ]; then
  echo '{"decision":"block","reason":"Required output file was not written. Please produce the expected output before stopping."}'
  exit 0
fi

# Default: allow
exit 0
