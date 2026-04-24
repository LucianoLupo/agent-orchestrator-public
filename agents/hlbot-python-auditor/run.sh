#!/usr/bin/env bash
# Standalone runner for agent "hlbot-python-auditor"
# Usage: ./run.sh [additional claude args...]
DIR="$(cd "$(dirname "$0")" && pwd)"
NAME="$(basename "$DIR")"
MODEL=$(node -e "process.stdout.write(require('./config.json').model)" 2>/dev/null || echo "sonnet")
MAX_TURNS=$(node -e "process.stdout.write(String(require('./config.json').maxTurns))" 2>/dev/null || echo "25")

cd "$DIR"
exec claude \
  --dangerously-skip-permissions \
  --max-turns "$MAX_TURNS" \
  --model "$MODEL" \
  -p "You are agent '$NAME'. Read your CLAUDE.md for identity and instructions. Execute your mission. Date: $(date -Iseconds)" \
  "$@"
