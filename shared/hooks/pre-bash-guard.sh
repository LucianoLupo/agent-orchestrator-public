#!/bin/bash
# PreToolUse Hook - Block destructive bash commands
# Exit 2 = block the tool use. Stdout = message to Claude.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

[ -z "$COMMAND" ] && exit 0

# rm with recursive+force targeting dangerous paths (root, home, parent dirs).
# Matches any path that STARTS with /, ~, $HOME, or .. — catches rm -rf ~/Desktop
# (the "Mike Wolak case") because tilde expansion makes the whole subtree disappear.
# Forms blocked:
#   rm -rf /…   rm -rf ~…   rm -rf ~/…   rm -fr $HOME/…   rm -rf ../…
#   rm --recursive --force ~…   rm --force --recursive ~…
RM_DANGER_TARGET='(/|~|\$HOME|\.\.)'
# Combined short flags containing both r and f in any order (e.g. -rf, -fr, -rfv, -vrf)
if echo "$COMMAND" | grep -qE "^[[:space:]]*rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)[[:space:]]+${RM_DANGER_TARGET}"; then
  echo "BLOCKED: rm -rf targeting root, home, or parent directory. Confirm with user first." >&2
  exit 2
fi
# Long flags --recursive --force in either order, possibly separated by other flags
if echo "$COMMAND" | grep -qE "^[[:space:]]*rm[[:space:]]+.*(--recursive[[:space:]]+.*--force|--force[[:space:]]+.*--recursive)[[:space:]]+${RM_DANGER_TARGET}"; then
  echo "BLOCKED: rm --recursive --force targeting root, home, or parent directory. Confirm with user first." >&2
  exit 2
fi

# Pipe remote content directly to a shell (curl|bash, wget|sh, etc.)
if echo "$COMMAND" | grep -qE '(curl|wget)[^|]*\|[[:space:]]*(ba|z|fi|da)?sh\b'; then
  echo "BLOCKED: piping remote content to shell. Download, inspect, then run." >&2
  exit 2
fi

# find ... -delete  (mass delete, no undo)
if echo "$COMMAND" | grep -qE 'find[[:space:]]+.*[[:space:]]-delete\b'; then
  echo "BLOCKED: find -delete is irreversible, confirm with user." >&2
  exit 2
fi

# Unqualified DELETE FROM (no WHERE clause). Matches DELETE FROM <table> terminated
# by ; " ' or end-of-string, with no WHERE keyword following the table name.
if echo "$COMMAND" | grep -iqE 'delete[[:space:]]+from[[:space:]]+[a-zA-Z_][a-zA-Z0-9_.]*[[:space:]]*(;|"|'"'"'|$)' \
   && ! echo "$COMMAND" | grep -iqE 'delete[[:space:]]+from[[:space:]]+[a-zA-Z_][a-zA-Z0-9_.]*[[:space:]]+where\b'; then
  echo "BLOCKED: DELETE without WHERE clause. Confirm with user first." >&2
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
