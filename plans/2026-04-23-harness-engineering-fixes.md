# Harness Engineering Fixes

**Date:** 2026-04-23
**Scope:** Medium (touches templates/, shared/hooks/, shared/skills/, orchestrator.mjs, tests)
**Source audit:** Full audit against Obsidian vault harness engineering corpus (Agent Harness Synthesis, Context Engineering for AI Coding Agents, OpenDev, Hermes Portable Layers, Hooks — Deep Research + Safety + Memory + Workflow).

## Goal

Bring the harness-construction layer of agent-orchestrator up to the state of the art documented in the vault. The orchestration + compounding layers (pipelines, autoresearch, genetic, judge+audit) are already excellent and **out of scope**. This plan targets only what `createAgent()` produces and the hooks it installs.

## Audit summary (what's broken)

1. 🔴 `shared/rules/*.md` uses Cursor `paths:` frontmatter — dead code, Claude Code never loads them
2. 🔴 first-principles is triple-loaded (skill + inlined in 4 templates + mature agents)
3. 🟡 `pre-bash-guard.sh` regex has a `\s*$` anchor — `rm -rf ~/Desktop` passes
4. 🟡 Secret scanner missing Stripe, `sk-ant-`, SendGrid, generic hex tokens
5. 🟡 `stop-completion-check.sh` uses fragile substring matching — should be Haiku prompt hook
6. 🟡 No JIT reminders (no UserPromptSubmit, no PreCompact/SessionStart pair)
7. 🟡 Template CLAUDE.mds duplicate boilerplate (first-principles, verification loop, memory protocol inline)
8. 🟡 `--dangerously-skip-permissions` is default; no sandbox option for untrusted workdirs

## Out of scope

- Autoresearch / variant competition / genetic optimization — keep as-is
- Judge + audit prompts — already well-designed
- Pipeline topological execution — not touching
- Claude monitor TUI — separate project
- OTel / external observability — defer
- Existing agents' CLAUDE.md — leave as-is; only touch templates (existing agents were hand-tuned)

---

## Phase 1 — Deletions and consolidation (cheapest, highest signal)

**Goal:** make the harness thinner without removing any real functionality.

### 1.1 Strip inline first-principles from templates

- [ ] `templates/default/CLAUDE.md` — delete lines 65-83 (First Principles Thinking section)
- [ ] `templates/developer/CLAUDE.md` — delete lines 98-116
- [ ] `templates/researcher/CLAUDE.md` — delete lines 113-141 (includes Socratic Questioning Protocol — keep, it's unique)
- [ ] `templates/claw/CLAUDE.md` — delete lines 120-132
- [ ] Add a single-line pointer at the bottom of each: `> Access \`skills/first-principles/\` when a problem needs fundamental analysis.`

**Verify:** `wc -l templates/*/CLAUDE.md` — default should be ~65, developer ~98, researcher drops ~15 only (keep Socratic questions), claw ~120.

### 1.2 Remove or repurpose `shared/rules/`

Three options, pick one:

- **(A) Delete** — simplest. `rm -r shared/rules/` and remove the copy block at orchestrator.mjs:525-532.
- **(B) Convert to Skills** — make each a proper `SKILL.md` with a description that triggers on language mentions. Move to `shared/skills/typescript-hygiene/`, `python-hygiene/`, `rust-hygiene/`.
- **(C) Inject via SessionStart hook** — one hook that detects workspace language (package.json, pyproject.toml, Cargo.toml) and echoes the one-sentence rule.

**Recommended: (A).** The rules are 1-2 sentences each; not worth the machinery. If language-specific rules matter later, do (C).

**Verify:** orchestrator.test.mjs still passes; grep codebase for `\.claude/rules` — should have no hits after removal.

### 1.3 Move first-principles content to skill-only

- [ ] Confirm `shared/skills/first-principles/SKILL.md` has the full framework (it does, 73 lines — already complete)
- [ ] Check the description trigger is good: currently "Use when asked to 'think from first principles'..." — solid

**Verify:** after Phase 1.1+1.3, running `node orchestrator.mjs create --name test-fp --mission "..." --template default` produces a CLAUDE.md under 70 lines that still has the skill available via `skills/first-principles/`.

---

## Phase 2 — Hook hardening (safety)

**Goal:** close the gaps documented in `Claude Code Hooks - Safety Guardrails and Security`.

### 2.1 Fix `pre-bash-guard.sh`

- [ ] Remove `\s*$` anchor from `rm -rf` regex — replace with `rm\s+.*(-rf|-fr|--recursive\s+--force)\s+(/|~|\$HOME|\.\.)` so `rm -rf ~/Desktop` gets blocked
- [ ] Add `curl.*\|\s*(ba)?sh` (pipe-to-shell)
- [ ] Add `find\s+.*\s+-delete` (find-delete)
- [ ] Add `DELETE\s+FROM\s+\w+\s*;?\s*$` (unqualified DELETE)
- [ ] Add `dd\s+if=.*\s+of=/dev/` (already has `of=/dev/`, this tightens)

**Verify:** write a shell test that pipes mock JSON inputs for each dangerous pattern through the hook and asserts exit 2.

### 2.2 Expand `pre-write-secret-scan.sh`

Add patterns from the safety corpus:
- [ ] `sk-ant-[A-Za-z0-9-]{80,}` (Anthropic)
- [ ] `sk_(live|test)_[A-Za-z0-9]{24,}` (Stripe)
- [ ] `SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}` (SendGrid)
- [ ] `sk-[A-Za-z0-9]{48}` (OpenAI — currently missing)

**Verify:** shell test with a Write payload containing each pattern → exit 2 with the right label.

### 2.3 Replace `stop-completion-check.sh` heuristic with prompt hook

Current: regex matches "I'll implement" without "done" — brittle.

New approach (two layers, keep both):
1. Deterministic: `AGENT_OUTPUT_FILE` existence check (already correct, lines 29-31) — keep
2. Semantic: Haiku prompt hook that evaluates completion

- [ ] Add new hook entry in `shared/settings.json`:
  ```json
  {"type": "prompt", "prompt": "Given the mission in the agent's CLAUDE.md and the last assistant message in $ARGUMENTS, is the work actually complete? Return {\"ok\": true} if done, {\"ok\": false, \"reason\": \"...\"} if promised but not delivered. stop_hook_active=true means allow immediately.", "model": "haiku", "timeout": 30}
  ```
- [ ] Keep `stop-completion-check.sh` for the `AGENT_OUTPUT_FILE` deterministic gate (it's fast and reliable)
- [ ] Remove the regex heuristic block (lines 18-26)

**Cost estimate:** ~$0.001/call × typical 5-10 stops per run = cents/day.

**Verify:** run an agent, force it to stop mid-work, confirm the prompt hook blocks with a semantic reason.

---

## Phase 3 — Context engineering (new hooks)

**Goal:** implement JIT reminders and compaction survival from the OpenDev / Context Engineering notes.

### 3.1 Add `UserPromptSubmit` reminder hook

- [ ] New script `shared/hooks/pre-prompt-reminder.sh`:
  ```bash
  # Reads ../config.json (via cwd = agentDir), echoes one-line reminder
  MISSION=$(jq -r '.mission' "$CLAUDE_PROJECT_DIR/config.json" 2>/dev/null | head -c 200)
  MAX=$(jq -r '.maxTurns' "$CLAUDE_PROJECT_DIR/config.json" 2>/dev/null)
  echo "Mission: $MISSION | Budget: $MAX turns | Date: $(date -u +%Y-%m-%d)"
  ```
- [ ] Add to `shared/settings.json` under `UserPromptSubmit`

**Verify:** run an agent, check the first user turn has a system-reminder with mission echoed.

### 3.2 Add `PreCompact` backup hook

- [ ] New script `shared/hooks/pre-compact-backup.sh`:
  ```bash
  # Save MEMORY.md + last N messages of transcript to $AGENT_RUN_DIR/pre-compact-<ts>.md
  ```
- [ ] Add to `shared/settings.json` under `PreCompact`

**Verify:** trigger manual compact (`/compact`), confirm file written to run dir.

### 3.3 Add `SessionStart` context injection

- [ ] New script `shared/hooks/session-start-context.sh`:
  ```bash
  # Echo cwd, branch (if git), recent commits, memory summary
  ```
- [ ] Add to `shared/settings.json` under `SessionStart` (matcher: startup|resume|compact)

**Verify:** agent run output shows injected context on first turn.

---

## Phase 4 — (Optional) Sandbox flag

Deferred unless needed. If implementing:

- [ ] Add `--sandbox` flag to `create` command
- [ ] When set, `run.sh` wraps the claude invocation in `devc .` (Trail of Bits devcontainer)
- [ ] Document in README which agents should use it (any with external workdir)

---

## Testing strategy

- Each phase ends with `node --test orchestrator.test.mjs` — 188 tests must stay green
- Add shell tests for new hooks: `shared/hooks/__tests__/*.sh` (can be a bash test runner)
- Integration test: create a fresh agent after each phase, run it against a trivial mission, verify hooks fire (check activity.jsonl + run output)
- Backward compat: existing agents under `agents/` are NOT modified. Their CLAUDE.md keeps inline first-principles. Only templates change.

## Rollout

- Phase 1 and Phase 2 are independently safe — commit separately
- Phase 3 requires Claude Code 2.1+ for async hooks (check version first)
- Phase 4 is opt-in via flag — no rollout risk

## Estimated size

- Phase 1: ~6 file edits, ~80 lines removed, ~10 added
- Phase 2: ~3 file edits (2 hooks + settings.json), ~40 lines changed
- Phase 3: ~3 new scripts + settings.json, ~80 lines
- Phase 4: ~1 flag + 1 wrapper, ~30 lines

Total: ~12 files, ~220 lines of churn. Medium scope, one focused session to execute.

## What stays unchanged (deliberately)

- orchestrator.mjs core engine — no changes beyond removing the rules-copy block (Phase 1.2)
- Judge + audit prompts — already strong
- Pipeline orchestration logic
- Cost tracking, atomic state, stale lock recovery
- Claw template's coordinator pattern
- All existing agents' CLAUDE.md files

## Success criteria

After all phases:
1. New agent CLAUDE.md size drops ~18 lines per template (measurable via `wc -l` — original estimate of 30-40 was optimistic; the actual reduction is a single FP block per template)
2. `pre-bash-guard.sh` blocks `rm -rf ~/Desktop` (test case)
3. Every agent run writes a `system-reminder` from `UserPromptSubmit` hook to transcript
4. Compaction triggers a backup file in the run dir
5. 188 tests still pass; new hook tests added
6. `orchestrator audit` score on a fresh-from-template agent improves measurably (pre/post audit comparison)

---

## Implementation Team (dispatch via Claude Code `Agent` tool)

Three specialist agents run in 2 waves + a reviewer. All read this plan file first.

### Wave 1 — Parallel (no file conflicts)

**Agent A: `harness-trimmer`** (model: sonnet)
- Scope: Phase 1 only
- Touches: `templates/default/CLAUDE.md`, `templates/developer/CLAUDE.md`, `templates/researcher/CLAUDE.md`, `templates/claw/CLAUDE.md`, `shared/rules/` (delete), `orchestrator.mjs:525-532` (remove rules-copy block)
- Independence: no overlap with other waves
- Verification: `wc -l templates/*/CLAUDE.md`, `grep -r "\.claude/rules" orchestrator.mjs` returns empty, `node --test orchestrator.test.mjs` green
- Commit message: `refactor(harness): strip inline first-principles, remove dead shared/rules`

**Agent B: `hook-safety-hardener`** (model: sonnet)
- Scope: Phase 2.1 + 2.2 only (does NOT touch settings.json or stop-completion-check yet)
- Touches: `shared/hooks/pre-bash-guard.sh`, `shared/hooks/pre-write-secret-scan.sh`, plus creates `shared/hooks/__tests__/` with bash test cases
- Independence: pure hook-content edits, no settings.json
- Verification: test script runs each dangerous pattern through the hook, asserts exit 2; same for secret patterns
- Commit message: `fix(hooks): close bash-guard regex gap, expand secret patterns`

### Wave 2 — Sequential (owns settings.json)

**Agent C: `context-engineer`** (model: sonnet)
- Scope: Phase 2.3 + Phase 3 (all hook work that modifies settings.json)
- Runs AFTER A and B merge, because it's the sole writer of `shared/settings.json` in this round
- Touches: creates `pre-prompt-reminder.sh`, `pre-compact-backup.sh`, `session-start-context.sh`; rewrites `stop-completion-check.sh` to drop regex heuristic; updates `shared/settings.json` with new hook entries (UserPromptSubmit, PreCompact, SessionStart, Stop prompt-type)
- Verification: create throwaway agent (`node orchestrator.mjs create --name _test_hooks --mission "smoke test" --template default`), run it, confirm activity.jsonl + system-reminder visible, delete it
- Commit message: `feat(hooks): add JIT reminders, compact backup, semantic stop check`

### Wave 3 — Review

**Agent D: `harness-reviewer`** (model: sonnet, read-only)
- Scope: validate everything
- Tasks:
  1. Run `node --test orchestrator.test.mjs` — all 188 tests green
  2. Create a fresh agent from `default` template; run `orchestrator audit` on it
  3. Compare audit scores vs a baseline (score of a pre-fix agent — capture one before Wave 1 starts)
  4. Verify each success criterion in this plan's Success criteria section
  5. Write a short report to `plans/2026-04-23-harness-engineering-fixes-REPORT.md` with before/after metrics
- Must NOT edit code; only verify
- If any criterion fails, report specifics and stop — don't patch

### Dispatch instructions (for fresh session after `/clear`)

```
1. Read this plan file.
2. Capture baseline: run `orchestrator audit frontend-auditor` (or any mature agent), save the score.
3. Spawn Wave 1 (A + B) in parallel via a single message with two Agent tool calls.
4. When both return green, review diffs, commit each separately.
5. Spawn Wave 2 (C) alone.
6. When C returns green, commit.
7. Spawn Wave 3 (D) alone. Read the report.
8. If D passes, consider squashing or keep 3 commits as the audit trail.
```

### Why not more parallelism

Phase 3 hooks all touch `shared/settings.json`. Giving multiple agents write access to the same JSON file triggers merge churn. One writer, serialized. The hook *script files* could theoretically be written in parallel, but the coordination cost isn't worth the ~20% speedup for 3 short scripts.

### Why not use agent-orchestrator itself

We're modifying the orchestrator it runs from. Chicken-and-egg. Claude Code Task-tool subagents are the right choice here — stateless, isolated, return summaries.

### Cost estimate

- Agent A: ~$0.30 (small edits, ~15 files read)
- Agent B: ~$0.40 (more test writing)
- Agent C: ~$0.80 (settings.json orchestration is the hardest)
- Agent D: ~$0.50 (read-only verification + report)
- **Total: ~$2** from a fresh session. Double that if dispatched from the current loaded session.
