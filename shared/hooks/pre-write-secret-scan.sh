#!/bin/bash
# PreToolUse Hook - Scan Edit/Write content for secrets before allowing file writes
# Exit 2 = block the tool use. Stdout = message to Claude.

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only scan Edit and Write
[[ "$TOOL" != "Edit" && "$TOOL" != "Write" ]] && exit 0

# Get the content being written
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

[ -z "$CONTENT" ] && exit 0

# Get file path
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Skip files where secrets are expected
case "$FILE_PATH" in
  *.env|*.env.*|*.env.local|*.env.example) exit 0 ;;
  *config.json|*credentials.json|*secrets.json) exit 0 ;;
  *.toml) exit 0 ;;  # Cargo.toml, pyproject.toml, config files
  *.cfg|*.ini|*.conf) exit 0 ;;
  *docker-compose*) exit 0 ;;
  */.claude/*) exit 0 ;;  # Claude's own config files
esac

# Scan for common secret patterns
FOUND=""

# AWS keys
echo "$CONTENT" | grep -qE 'AKIA[0-9A-Z]{16}' && FOUND="${FOUND}AWS Access Key, "

# Private keys
echo "$CONTENT" | grep -qF -- '-----BEGIN' && echo "$CONTENT" | grep -qF 'PRIVATE KEY' && FOUND="${FOUND}Private Key, "

# Generic API key patterns (long hex/base64 strings assigned to key/token/secret vars)
echo "$CONTENT" | grep -qiE '(api_key|api_secret|secret_key|private_key|access_token)\s*[=:]\s*["\x27][A-Za-z0-9+/=_-]{20,}' && FOUND="${FOUND}API Key/Secret, "

# Slack tokens
echo "$CONTENT" | grep -qE 'xox[bporas]-[0-9a-zA-Z-]+' && FOUND="${FOUND}Slack Token, "

# GitHub tokens
echo "$CONTENT" | grep -qE 'gh[pousr]_[A-Za-z0-9_]{36,}' && FOUND="${FOUND}GitHub Token, "

# JWT tokens
echo "$CONTENT" | grep -qE 'eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*' && FOUND="${FOUND}JWT Token, "

# Anthropic keys (MUST be checked before OpenAI: both start with sk-, and bash
# grep -E has no negative lookahead, so we de-dupe via ordering + a flag)
ANTHROPIC_HIT=0
if echo "$CONTENT" | grep -qE 'sk-ant-[A-Za-z0-9_-]{80,}'; then
  FOUND="${FOUND}Anthropic Key, "
  ANTHROPIC_HIT=1
fi

# Stripe keys (sk_live_ / sk_test_)
echo "$CONTENT" | grep -qE 'sk_(live|test)_[A-Za-z0-9]{24,}' && FOUND="${FOUND}Stripe Key, "

# SendGrid keys
echo "$CONTENT" | grep -qE 'SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}' && FOUND="${FOUND}SendGrid Key, "

# OpenAI keys (sk- + 48 alphanumerics). Skip if Anthropic already matched.
if [ "$ANTHROPIC_HIT" -eq 0 ]; then
  echo "$CONTENT" | grep -qE 'sk-[A-Za-z0-9]{48}' && FOUND="${FOUND}OpenAI Key, "
fi

if [ -n "$FOUND" ]; then
  FOUND="${FOUND%, }"  # trim trailing comma
  echo "WARNING: Potential secrets detected in ${FILE_PATH##*/}: ${FOUND}. If intentional (e.g. config file), confirm with the user before proceeding." >&2
  exit 2
fi

exit 0
