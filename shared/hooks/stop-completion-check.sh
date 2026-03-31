#!/bin/bash
# Stop Hook - Check if assistant left obvious incomplete work
# Parses the stop_hook_active flag and last_assistant_message
# Only blocks when clear signals of incompleteness are found

INPUT=$(cat)

# Prevent infinite loops — if we already blocked once, allow
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
[ "$STOP_ACTIVE" = "true" ] && exit 0

# Get the last assistant message
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')
[ -z "$LAST_MSG" ] && exit 0

# Check for clear incompleteness signals in the last message
# These patterns indicate Claude stopped mid-work
INCOMPLETE=false

# Explicitly said it will do something but didn't
echo "$LAST_MSG" | grep -qiE "I('ll| will) (now |next )?(implement|create|write|fix|update|add|build)" && \
  ! echo "$LAST_MSG" | grep -qiE "(done|complete|finish|implemented|created|written|fixed|updated|added|built)" && \
  INCOMPLETE=true

# Left a TODO or FIXME in the response
echo "$LAST_MSG" | grep -qE '\bTODO\b|\bFIXME\b|not yet implemented' && INCOMPLETE=true

# Check required output file exists (HOOK-02)
if [ -n "$AGENT_OUTPUT_FILE" ] && [ ! -f "$AGENT_OUTPUT_FILE" ]; then
  INCOMPLETE=true
fi

if [ "$INCOMPLETE" = "true" ]; then
  echo '{"decision":"block","reason":"It looks like you promised to do something but stopped before completing it. Please finish the work."}'
  exit 0
fi

# Default: allow
exit 0
