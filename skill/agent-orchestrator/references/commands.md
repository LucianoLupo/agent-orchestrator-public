# Agent Orchestrator — Command Reference

## Agent Lifecycle

```bash
# Create a new agent
node ~/agent-orchestrator/orchestrator.mjs create --name <n> --mission "<m>" [--template <t>] [--model <m>] [--max-turns <n>] [--interval <s>] [--workdir <path>] [--skills <s,s,...>] [--sub-model <m>] [--sub-max-turns <n>] [--workflow "<desc>"]

# Run an agent (optionally with a message or fresh session)
node ~/agent-orchestrator/orchestrator.mjs run <name> [-m "<msg>"] [--fresh]

# Send a follow-up message to an existing session
node ~/agent-orchestrator/orchestrator.mjs continue <name> "<msg>"

# List all agents
node ~/agent-orchestrator/orchestrator.mjs list

# List available skills from ~/.claude/skills/
node ~/agent-orchestrator/orchestrator.mjs list-skills

# Dashboard overview (status, costs, evals, running)
node ~/agent-orchestrator/orchestrator.mjs dashboard

# Show detailed status for an agent
node ~/agent-orchestrator/orchestrator.mjs status <name>

# Show latest output/logs
node ~/agent-orchestrator/orchestrator.mjs logs <name>

# Delete an agent (confirm with user first)
node ~/agent-orchestrator/orchestrator.mjs delete <name>

# Start the scheduler daemon
node ~/agent-orchestrator/orchestrator.mjs daemon [--max-concurrent <n>]
```

## Quality & Optimization

```bash
# Evaluate latest run (LLM-as-judge, 5 dimensions)
node ~/agent-orchestrator/orchestrator.mjs eval <name>

# Audit harness design quality
node ~/agent-orchestrator/orchestrator.mjs audit <name>

# Show/apply CLAUDE.md improvements from audit
node ~/agent-orchestrator/orchestrator.mjs improve <name> [--apply]

# Automated run-eval-improve loop (Karpathy-style)
node ~/agent-orchestrator/orchestrator.mjs autoresearch <name> [--max-iterations N] [--cost-budget USD] [--min-improvement N] [-m "<task>"]

# Fork N CLAUDE.md variants, run+eval all, pick winner
node ~/agent-orchestrator/orchestrator.mjs compete <name> [--variants N] [-m "<task>"]

# Multi-generation genetic optimization (wraps compete)
node ~/agent-orchestrator/orchestrator.mjs evolve <name> [--generations N] [--variants N] [-m "<task>"]
```

## Pipelines

```bash
# Validate pipeline config without running
node ~/agent-orchestrator/orchestrator.mjs pipeline validate <name>

# Execute a pipeline
node ~/agent-orchestrator/orchestrator.mjs pipeline run <name>

# Show run details
node ~/agent-orchestrator/orchestrator.mjs pipeline status <run-id>

# List all pipelines with recent runs
node ~/agent-orchestrator/orchestrator.mjs pipeline list
```
