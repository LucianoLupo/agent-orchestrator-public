#!/usr/bin/env bash
# OpenRouter wrapper that mimics Claude CLI interface
# Usage: openrouter-claude.sh --model <model> --max-turns <n> -p <prompt>

set -e

MODEL=""
MAX_TURNS=""
PROMPT=""
DANGEROUSLY_SKIP=""
OUTPUT_FORMAT=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --model)
      MODEL="$2"
      shift 2
      ;;
    --max-turns)
      MAX_TURNS="$2"
      shift 2
      ;;
    -p|--prompt)
      PROMPT="$2"
      shift 2
      ;;
    --dangerously-skip-permissions)
      DANGEROUSLY_SKIP="1"
      shift
      ;;
    --output-format)
      OUTPUT_FORMAT="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# Default to Kimi K2.6 if not specified
MODEL="${MODEL:-moonshotai/kimi-k2.6}"

# Call OpenRouter API
RESPONSE=$(curl -s https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "HTTP-Referer: https://github.com/LucianoLupo/agent-orchestrator" \
  -H "X-Title: Agent Orchestrator" \
  -d "{
    \"model\": \"${MODEL}\",
    \"messages\": [{\"role\": \"user\", \"content\": $(echo "$PROMPT" | jq -Rs .)}],
    \"max_tokens\": 4000
  }")

# Extract content
CONTENT=$(echo "$RESPONSE" | jq -r '.choices[0].message.content // .error.message')

# Output format handling
if [[ "$OUTPUT_FORMAT" == "json" ]]; then
  echo '{"content":'$(echo "$CONTENT" | jq -Rs .)'}'
else
  echo "$CONTENT"
fi
