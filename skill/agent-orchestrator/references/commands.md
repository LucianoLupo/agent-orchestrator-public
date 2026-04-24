# Agent Orchestrator — Command Reference

## Agent Lifecycle

```bash
# One-command natural-language → fully wired scheduled agent (preferred for casual requests)
node ~/projects/agent-orchestrator/orchestrator.mjs describe "<description>" [--yes] [--dry-run] [--no-bootstrap] [--no-schedule] [--max-iterations <n>] [--cost-budget <usd>] [--model <m>]

# Create a new agent with explicit fields (preferred for precise specs)
node ~/projects/agent-orchestrator/orchestrator.mjs create --name <n> --mission "<m>" [--template <t>] [--model <m>] [--max-turns <n>] [--interval <s>] [--workdir <path>] [--skills <s,s,...>] [--sub-model <m>] [--sub-max-turns <n>] [--workflow "<desc>"]

# Run an agent (optionally with a message or fresh session)
node ~/projects/agent-orchestrator/orchestrator.mjs run <name> [-m "<msg>"] [--fresh]

# Send a follow-up message to an existing session
node ~/projects/agent-orchestrator/orchestrator.mjs continue <name> "<msg>"

# List all agents
node ~/projects/agent-orchestrator/orchestrator.mjs list

# List available skills from ~/.claude/skills/
node ~/projects/agent-orchestrator/orchestrator.mjs list-skills

# Dashboard overview (status, costs, evals, running)
node ~/projects/agent-orchestrator/orchestrator.mjs dashboard

# Show detailed status for an agent
node ~/projects/agent-orchestrator/orchestrator.mjs status <name>

# Show latest output/logs
node ~/projects/agent-orchestrator/orchestrator.mjs logs <name>

# Delete an agent (confirm with user first)
node ~/projects/agent-orchestrator/orchestrator.mjs delete <name>

# Start the scheduler daemon (for legacy intervalSeconds scheduling)
node ~/projects/agent-orchestrator/orchestrator.mjs daemon [--max-concurrent <n>]
```

## Scheduling (cron-based, survives reboots)

```bash
# Install a schedule with a raw cron expression
node ~/projects/agent-orchestrator/orchestrator.mjs schedule <name> --cron "0 9 * * 1-5"

# Install with sugar
node ~/projects/agent-orchestrator/orchestrator.mjs schedule <name> --at "hourly"
node ~/projects/agent-orchestrator/orchestrator.mjs schedule <name> --at "daily 09:00"
node ~/projects/agent-orchestrator/orchestrator.mjs schedule <name> --at "weekdays 09:00"
node ~/projects/agent-orchestrator/orchestrator.mjs schedule <name> --at "weekly mon 09:00"

# If the agent already has intervalSeconds set, add --force to replace it
node ~/projects/agent-orchestrator/orchestrator.mjs schedule <name> --cron "0 9 * * *" --force

# Show schedule for one agent
node ~/projects/agent-orchestrator/orchestrator.mjs schedule <name>

# List all scheduled agents
node ~/projects/agent-orchestrator/orchestrator.mjs schedule list

# Uninstall (idempotent)
node ~/projects/agent-orchestrator/orchestrator.mjs schedule <name> --remove
```

- **macOS**: per-agent launchd plist at `~/Library/LaunchAgents/com.agent-orchestrator.<name>.plist`, validated via `plutil -lint` before loading
- **Linux**: user crontab line marked `# agent-orchestrator:<name>` — install/remove only touches lines with that marker
- Cron expressions too complex for launchd (e.g. `dom+dow` both set, or `* * * * *`) error out with a clear message rather than silently misscheduling

## Quality & Optimization

```bash
# Evaluate latest run (LLM-as-judge, 5 dimensions)
node ~/projects/agent-orchestrator/orchestrator.mjs eval <name>

# Audit harness design quality
node ~/projects/agent-orchestrator/orchestrator.mjs audit <name>

# Show/apply CLAUDE.md improvements from audit
node ~/projects/agent-orchestrator/orchestrator.mjs improve <name> [--apply]

# Automated run-eval-improve loop (Karpathy-style)
node ~/projects/agent-orchestrator/orchestrator.mjs autoresearch <name> [--max-iterations N] [--cost-budget USD] [--min-improvement N] [-m "<task>"]

# Fork N CLAUDE.md variants, run+eval all, pick winner
node ~/projects/agent-orchestrator/orchestrator.mjs compete <name> [--variants N] [-m "<task>"]

# Multi-generation genetic optimization (wraps compete)
node ~/projects/agent-orchestrator/orchestrator.mjs evolve <name> [--generations N] [--variants N] [-m "<task>"]
```

## Pipelines

```bash
# Validate pipeline config without running
node ~/projects/agent-orchestrator/orchestrator.mjs pipeline validate <name>

# Execute a pipeline
node ~/projects/agent-orchestrator/orchestrator.mjs pipeline run <name>

# Show run details
node ~/projects/agent-orchestrator/orchestrator.mjs pipeline status <run-id>

# List all pipelines with recent runs
node ~/projects/agent-orchestrator/orchestrator.mjs pipeline list
```
