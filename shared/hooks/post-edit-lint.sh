#!/bin/bash
# PostToolUse Hook - Auto-lint after file edits
# Runs the appropriate linter if available. Silent skip if no linter found.

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only run after Edit or Write
[[ "$TOOL" != "Edit" && "$TOOL" != "Write" ]] && exit 0
[ -z "$FILE" ] && exit 0
[ ! -f "$FILE" ] && exit 0

EXT="${FILE##*.}"
DIR=$(dirname "$FILE")
OUTPUT=""

case "$EXT" in
  ts|tsx|mts|cts)
    # Find eslint and tsc walking up from file
    CHECK_DIR="$DIR"
    ESLINT=""
    TSC=""
    while [ "$CHECK_DIR" != "/" ]; do
      [ -z "$ESLINT" ] && [ -x "$CHECK_DIR/node_modules/.bin/eslint" ] && ESLINT="$CHECK_DIR/node_modules/.bin/eslint"
      [ -z "$TSC" ] && [ -x "$CHECK_DIR/node_modules/.bin/tsc" ] && TSC="$CHECK_DIR/node_modules/.bin/tsc"
      CHECK_DIR=$(dirname "$CHECK_DIR")
    done
    if [ -n "$ESLINT" ]; then
      OUTPUT=$($ESLINT --no-warn-ignored --max-warnings=0 "$FILE" 2>&1) || true
    fi
    if [ -n "$TSC" ]; then
      TSC_OUT=$($TSC --noEmit --pretty false 2>&1 | grep "$(basename "$FILE")" | head -10) || true
      [ -n "$TSC_OUT" ] && OUTPUT="${OUTPUT}${OUTPUT:+\n}TypeScript errors:\n${TSC_OUT}"
    fi
    ;;
  js|jsx|mjs|cjs)
    CHECK_DIR="$DIR"
    ESLINT=""
    while [ "$CHECK_DIR" != "/" ]; do
      [ -z "$ESLINT" ] && [ -x "$CHECK_DIR/node_modules/.bin/eslint" ] && ESLINT="$CHECK_DIR/node_modules/.bin/eslint"
      CHECK_DIR=$(dirname "$CHECK_DIR")
    done
    if [ -n "$ESLINT" ]; then
      OUTPUT=$($ESLINT --no-warn-ignored --max-warnings=0 "$FILE" 2>&1) || true
    fi
    ;;
  py)
    if command -v ruff &>/dev/null; then
      OUTPUT=$(ruff check "$FILE" 2>&1) || true
    elif command -v flake8 &>/dev/null; then
      OUTPUT=$(flake8 "$FILE" 2>&1) || true
    fi
    # Type checking via pyright if available
    if command -v pyright &>/dev/null; then
      PY_OUT=$(pyright "$FILE" 2>&1 | grep -E "error:" | head -10) || true
      [ -n "$PY_OUT" ] && OUTPUT="${OUTPUT}${OUTPUT:+\n}Type errors:\n${PY_OUT}"
    fi
    ;;
  rs)
    # Lightweight: check formatting only (cargo check is too heavy)
    if command -v rustfmt &>/dev/null; then
      OUTPUT=$(rustfmt --check "$FILE" 2>&1) || true
    fi
    ;;
esac

# Only output if there are lint issues
if [ -n "$OUTPUT" ] && [ "$OUTPUT" != "" ]; then
  echo "Lint issues in $FILE:"
  echo "$OUTPUT" | head -20
fi

exit 0
