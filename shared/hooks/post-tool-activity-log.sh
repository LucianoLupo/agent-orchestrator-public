#!/bin/bash
# PostToolUse Hook - Log file activity for orchestrator observability
# Appends to per-run activity.jsonl when AGENT_RUN_DIR is set.
# Only tracks Edit and Write (not Read — too noisy, 50-100x/session).

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

case "$TOOL" in
  Edit|Write) ACTION="write" ;;
  *) exit 0 ;;
esac

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

# Need a run directory to log to
[ -z "$AGENT_RUN_DIR" ] && exit 0
[ ! -d "$AGENT_RUN_DIR" ] && exit 0

LOG_FILE="$AGENT_RUN_DIR/activity.jsonl"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "{\"source\":\"hook\",\"tool\":\"$TOOL\",\"file\":\"$FILE\",\"action\":\"$ACTION\",\"timestamp\":\"$TIMESTAMP\"}" >> "$LOG_FILE"

exit 0
