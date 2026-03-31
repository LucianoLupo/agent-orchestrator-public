# Agent Orchestrator

A zero-dependency, single-file Node.js CLI and daemon that creates, runs, evaluates, and **evolves** autonomous Claude Code agents. Each agent gets a CLAUDE.md harness, persistent memory, skills, safety hooks, and an eval/audit improvement loop. The daemon schedules agents with concurrency control. Pipelines coordinate multi-agent workflows with parallel execution and supervisor quality gates. The autoresearch loop and genetic optimizer autonomously improve agent harnesses over time.

## Features

**Agent Lifecycle**
- Create agents from templates (default, developer, researcher, claw)
- CLAUDE.md harness with mission, identity, and operating rules
- Persistent memory system per agent
- Skills (first-principles, orchestrator-awareness, user skills via symlinks)
- Session resume for multi-turn conversations
- Auto-continue when agents hit turn limits

**Daemon Mode**
- Scheduled agent execution on configurable intervals
- Concurrency control (configurable max parallel agents)
- Exponential backoff on transient failures
- Failure classification (auth errors vs transient)
- Daily cost budgets with circuit breaker
- Stale process recovery after crashes (PID + lock expiry)

**Pipeline Orchestration**
- JSON-defined pipelines with stages, dependencies, and data flow
- Parallel execution: fan-out/fan-in via level-grouped topological sort
- `$prev` data flow (single dependency) and `$all` JSON map (multi-dependency)
- Crash-safe atomic state persistence
- Supervisor quality gates (proceed / retry with feedback / abort)
- File activity tracking enriches gate decisions
- Daemon coexistence (pipeline workers excluded from scheduling)

**Quality Control & Optimization**
- LLM-as-judge eval system (5 dimensions, rolling average)
- Harness audit with structured improvement suggestions
- `improve` command applies audit patches to CLAUDE.md
- **Autoresearch loop**: automated run→eval→improve→revert cycle (Karpathy-style)
- **Variant competition**: fork N CLAUDE.md variants, eval all, pick winner
- **Genetic optimization**: multi-generation evolution of agent harnesses
- Agent dashboard: status, costs, evals, running agents overview
- Safety hooks: bash guard, secret scan, post-edit lint, completion check, activity log

## Requirements

- Node.js >= 20
- Claude Code CLI (`claude`) installed and authenticated

## Quick Start

```bash
# Create an agent
node orchestrator.mjs create \
  --name my-researcher \
  --mission "Research and summarize recent developments in AI safety" \
  --template researcher \
  --model sonnet

# Run it
node orchestrator.mjs run my-researcher

# Check status
node orchestrator.mjs status my-researcher

# Start the daemon (runs all scheduled agents)
node orchestrator.mjs daemon
```

## CLI Reference

```
orchestrator create         Create a new agent
  --name <n>                Agent name (required)
  --mission "<m>"           Agent mission (required)
  --template <t>            Template: default, researcher, developer, claw
  --model <m>               Claude model (default: sonnet)
  --max-turns <n>           Max turns per run (default: 25)
  --interval <s>            Auto-run interval in seconds (daemon mode)
  --workdir <path>          Target project directory
  --skills <s,s,...>        Comma-separated skills from ~/.claude/skills/
  --sub-model <m>           Sub-session model for claw template (default: sonnet)
  --sub-max-turns <n>       Sub-session turn limit for claw template (default: 100)
  --workflow "<description>" Workflow steps for claw template

orchestrator run <name>     Run agent (new or resume session)
  -m, --message "<msg>"     Pass a task/instruction
  --fresh                   Force a new session

orchestrator continue <name> "<msg>"   Send follow-up message
orchestrator eval <name>               Evaluate latest run (1-10 score)
orchestrator audit <name>              Audit harness design quality
orchestrator improve <name>            Show CLAUDE.md improvements from audit
  --apply                              Apply improvements
orchestrator autoresearch <name>       Automated run→eval→improve loop
  --max-iterations <n>                 Max loop iterations (default: 10)
  --cost-budget <usd>                  Total USD budget (default: 5.0)
  --min-improvement <n>                Score delta threshold (default: 0.2)
  -m "<task>"                          Task message for each run
orchestrator compete <name>            Compete N CLAUDE.md variants, pick winner
  --variants <n>                       Number of variants (default: 3)
  -m "<task>"                          Task message for each variant
orchestrator evolve <name>             Multi-generation genetic optimization
  --generations <n>                    Generations (default: 5)
  --variants <n>                       Variants per generation (default: 3)
  -m "<task>"                          Task message for each run
orchestrator list                      List all agents
orchestrator dashboard                 Agent overview: status, costs, evals
orchestrator status <name>             Detailed agent status
orchestrator logs <name>               Show latest run output
orchestrator delete <name>             Remove an agent
orchestrator daemon                    Start the scheduling daemon
  --max-concurrent <n>                 Max parallel agents (default: 3)

orchestrator pipeline validate <name>  Validate pipeline config
orchestrator pipeline run <name>       Run a pipeline
orchestrator pipeline status <run-id>  Show pipeline run status
orchestrator pipeline list             List all pipeline runs
```

## Project Structure

```
agent-orchestrator/
├── orchestrator.mjs          # Core engine (2,785 lines, zero dependencies)
├── orchestrator.test.mjs     # Test suite (188 tests)
├── package.json
├── agents/                   # Agent instances (created at runtime)
│   └── <agent-name>/
│       ├── CLAUDE.md         # Agent harness (identity, mission, rules)
│       ├── config.json       # Agent configuration
│       ├── state.json        # Runtime state (status, costs, sessions)
│       ├── SKILL.md          # Makes agent invocable as a skill
│       ├── run.sh            # Standalone runner script
│       ├── .claude/
│       │   ├── settings.json # Hook configuration
│       │   ├── memory/       # Persistent agent memory
│       │   └── rules/        # Language-specific rules
│       ├── skills/
│       │   ├── first-principles/
│       │   └── orchestrator-awareness/
│       └── runs/             # Per-run output directories
├── pipelines/                # Pipeline definitions and runs
│   └── <pipeline-name>/
│       ├── pipeline.json     # Pipeline config (stages, deps, prompts)
│       └── runs/             # Per-run state and stage outputs
├── templates/                # Agent CLAUDE.md templates
│   ├── default/
│   ├── developer/
│   ├── researcher/
│   ├── judge/
│   └── claw/               # Coordinator pattern (spawn sub-sessions)
├── shared/
│   ├── settings.json         # Shared hook configuration
│   ├── hooks/
│   │   ├── pre-bash-guard.sh           # Blocks dangerous shell patterns
│   │   ├── pre-write-secret-scan.sh    # Scans for secrets in edits
│   │   ├── post-edit-lint.sh           # Auto-lints after file edits
│   │   ├── post-tool-activity-log.sh   # Logs file activity per run
│   │   └── stop-completion-check.sh    # Validates output before stop
│   ├── skills/
│   │   ├── first-principles/           # Reasoning framework skill
│   │   └── orchestrator-awareness/     # Orchestrator context skill
│   └── rules/                          # Language-specific coding rules
├── lib/                      # (reserved for future utilities)
└── systemd/                  # Systemd service file for daemon
```

## Pipeline Example

```json
{
  "name": "research-and-review",
  "version": 1,
  "description": "Research a topic then review the output",
  "stages": [
    {
      "name": "research",
      "agent": "my-researcher",
      "prompt": "Research recent developments in AI safety and write a report."
    },
    {
      "name": "review",
      "agent": "my-reviewer",
      "prompt": "Review the research report at $prev for accuracy and completeness.",
      "depends_on": ["research"],
      "max_retries": 2
    }
  ]
}
```

```bash
# Save as pipelines/research-and-review/pipeline.json, then:
node orchestrator.mjs pipeline run research-and-review
```

After each stage, a Claude supervisor evaluates the output and decides to proceed, retry with feedback, or abort the pipeline.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CLAUDE_BIN` | Override claude CLI path (default: `claude`) |
| `AGENT_OUTPUT_FILE` | Set by orchestrator for pipeline stage output |
| `AGENT_RUN_DIR` | Set by orchestrator — path to current run directory |

## Architecture

- **Single file**: All orchestrator logic in `orchestrator.mjs`
- **Zero dependencies**: Node.js built-ins only (`child_process`, `fs`, `path`, `crypto`)
- **Claude Code CLI**: Agents spawned via `claude --dangerously-skip-permissions`
- **Atomic state**: All state writes use tmp-file-then-rename for crash safety
- **Policy-as-architecture**: Safety enforced via hooks and env vars, not prompts

## Tests

```bash
node --test orchestrator.test.mjs
```

188 tests covering: crash recovery, cost tracking, backoff, failure classification, parallel pipeline execution, gate decisions, skill injection, activity tracking, autoresearch loop, variant competition, genetic optimization, and integration tests with mocked agent spawning.

## Milestones

- **v1.0** (2026-03-22): Production hardening — daemon correctness, reliability, cost controls, meta-optimization
- **v2.0** (2026-03-23): Pipeline orchestration — sequential execution, supervisor gates, crash-safe state, data flow
- **v2.0.1** (2026-03-24): Observability — orchestrator-awareness skill, file activity tracking, gate enrichment
- **v2.1** (2026-03-24): Parallel execution, autoresearch loop, dashboard, 5-agent audit
- **v3.0** (2026-03-25): Claw template, variant competition, genetic optimization
