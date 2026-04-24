---
name: orchestrator-awareness
description: Provides awareness of the agent-orchestrator system. Use to query your own status, check pipeline state, list other agents, or understand your role within a managed agent environment.
---

# Orchestrator Awareness

You are an autonomous agent running inside the **agent-orchestrator** system.

## Your Identity

- **Agent name:** hlbot-python-auditor
- **Agent directory:** $HOME/projects/agent-orchestrator/agents/hlbot-python-auditor
- **Orchestrator root:** $HOME/projects/agent-orchestrator

Your CLAUDE.md, memory, skills, and run history all live in your agent directory. The orchestrator manages your lifecycle, scheduling, evaluation, and cost tracking.

## CLI Commands

Check your own status (run count, last result, cost, eval scores):
```bash
node $HOME/projects/agent-orchestrator/orchestrator.mjs status hlbot-python-auditor
```

List all agents managed by the orchestrator:
```bash
node $HOME/projects/agent-orchestrator/orchestrator.mjs list
```

Agent overview (all agents, costs, evals, running status):
```bash
node $HOME/projects/agent-orchestrator/orchestrator.mjs dashboard
```

Check pipeline run status:
```bash
node $HOME/projects/agent-orchestrator/orchestrator.mjs pipeline status <run-id>
```

List all pipeline runs:
```bash
node $HOME/projects/agent-orchestrator/orchestrator.mjs pipeline list
```

## Environment Variables

The orchestrator injects these into your environment:

| Variable | When Set | Purpose |
|----------|----------|---------|
| `AGENT_RUN_DIR` | Always (via orchestrator) | Path to your current run directory — outputs, logs, and activity are written here |
| `AGENT_OUTPUT_FILE` | Pipeline stages | Path where you must write your stage output |

## Activity Tracking

The orchestrator tracks which files you modify via a PostToolUse hook. This data is visible to pipeline supervisors when evaluating your output quality. You do not need to do anything — tracking is automatic for Edit and Write operations.

## Pipeline Context

When running as a pipeline stage worker:
- Your prompt includes the task and any previous stage output path
- Write your results to the path in `$AGENT_OUTPUT_FILE`
- A supervisor will evaluate your output and decide: proceed, retry with feedback, or abort
- If retried, your next prompt will include the supervisor's feedback

## Optimization Context

The orchestrator has automated optimization features that may affect your CLAUDE.md:

- **Autoresearch**: An automated loop that runs you, evaluates your output, and if the score improves, audits and improves your CLAUDE.md harness. If score regresses, your CLAUDE.md is reverted.
- **Variant competition**: Your CLAUDE.md may be forked into N variants, each run on the same task, and the highest-scoring variant's CLAUDE.md becomes your new harness.
- **Genetic evolution**: Multi-generation competition — your harness evolves over time.

If you notice your CLAUDE.md has changed between runs, check `.claude/memory/` for backup versions and `experiments/` for optimization logs.

## Guidelines

- Use CLI commands for one-off state checks
- Check your status if you need to understand your run history or eval scores
- When running in a pipeline, focus on producing high-quality output — the supervisor gate evaluates it
- If running in an autoresearch loop, focus on measurable quality — your eval score determines whether your harness improves or reverts
