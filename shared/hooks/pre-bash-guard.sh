#!/bin/bash
# PreToolUse Hook - Block destructive bash commands
# Exit 2 = block the tool use. Stdout = message to Claude.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

[ -z "$COMMAND" ] && exit 0

# rm -rf with dangerous targets (root, home, entire project dirs)
if echo "$COMMAND" | grep -qE 'rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)*(\/|~|\$HOME|\.\.)\s*$'; then
  echo "BLOCKED: rm -rf targeting root, home, or parent directory. Confirm with user first." >&2
  exit 2
fi

# git push --force to main/master
if echo "$COMMAND" | grep -qE 'git\s+push\s+.*--force.*\s+(main|master)'; then
  echo "BLOCKED: Force push to main/master. Confirm with user first." >&2
  exit 2
fi
if echo "$COMMAND" | grep -qE 'git\s+push\s+-f\s+.*\s+(main|master)'; then
  echo "BLOCKED: Force push to main/master. Confirm with user first." >&2
  exit 2
fi

# git reset --hard
if echo "$COMMAND" | grep -qE 'git\s+reset\s+--hard'; then
  echo "BLOCKED: git reset --hard can destroy uncommitted work. Confirm with user first." >&2
  exit 2
fi

# git clean -f (deletes untracked files)
if echo "$COMMAND" | grep -qE 'git\s+clean\s+.*-[a-zA-Z]*f'; then
  echo "BLOCKED: git clean -f deletes untracked files permanently. Confirm with user first." >&2
  exit 2
fi

# DROP DATABASE / DROP TABLE
if echo "$COMMAND" | grep -iqE '(drop\s+(database|table|schema)|truncate\s+table)'; then
  echo "BLOCKED: Destructive database operation. Confirm with user first." >&2
  exit 2
fi

# chmod -R 777 (security risk)
if echo "$COMMAND" | grep -qE 'chmod\s+(-R\s+)?777'; then
  echo "BLOCKED: chmod 777 is a security risk. Use specific permissions instead." >&2
  exit 2
fi

# dd writing to disk devices
if echo "$COMMAND" | grep -qE 'dd\s+.*of=/dev/'; then
  echo "BLOCKED: dd writing to device. Confirm with user first." >&2
  exit 2
fi

# mkfs (format filesystem)
if echo "$COMMAND" | grep -qE 'mkfs'; then
  echo "BLOCKED: Filesystem format operation. Confirm with user first." >&2
  exit 2
fi

exit 0
