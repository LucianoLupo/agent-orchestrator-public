---
name: agent-orchestrator
description: Create, manage, and run autonomous agents via the Agent Orchestrator. Use when asked to "create an agent", "spawn an agent", "make an agent", "run agent", "list agents", "agent status", or any request to create autonomous workers for specific tasks. Do NOT use for Claude Code's built-in Agent/subagent tool, general questions about agent patterns, or discussions about AI agents conceptually.
---

# Agent Orchestrator Skill

You manage the Agent Orchestrator at `~/projects/agent-orchestrator/`.

## Command Reference

See `references/commands.md` for the full CLI reference. Quick overview:

- **Agent lifecycle:** `describe`, `create`, `run`, `continue`, `list`, `list-skills`, `dashboard`, `status`, `logs`, `delete`, `daemon`
- **Scheduling:** `schedule <name> --cron/--at/--remove/list` (per-agent launchd on macOS, crontab on Linux)
- **Quality & optimization:** `eval`, `audit`, `improve`, `autoresearch`, `compete`, `evolve`
- **Pipelines:** `pipeline validate`, `pipeline run`, `pipeline status`, `pipeline list`

## Templates

- `default` — Generic autonomous agent
- `researcher` — Deep research with source integrity and verification loops
- `developer` — Code work with plan-execute-verify phases and git safety
- `claw` — Coordinator pattern: spawns sub-sessions for each step, reads results, loops

## When the User Asks to Create an Agent

**Two paths. Pick based on how precise the user's request is:**

### Path A (preferred for casual requests) — `describe`

If the user gives a natural-language description like *"a bug fixer that runs daily on /projects/my-app"* or *"something that audits my Rails app once a week"*, use `describe`. It parses intent via Haiku, shows the spec for confirmation, creates the agent, runs a bootstrap audit+improve loop to inject domain knowledge, and auto-installs the schedule if one was mentioned.

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs describe "<user's description>"
```

Flags the user may want:
- `--dry-run` — preview the parsed spec, create nothing
- `--yes` — skip the y/N confirm (only if user explicitly opts into automation)
- `--no-bootstrap` — skip the audit/improve loop to save money (default runs up to 2 iterations, capped at $1)
- `--no-schedule` — create but don't install a schedule
- `--cost-budget 0.50` / `--max-iterations 1` — tighter caps

Typical describe run costs $0.10–$0.50.

### Path B (for precise control) — manual `create`

If the user specifies exact fields ("name X, template developer, max-turns 40, workdir /foo"), use the full 8-step manual path in `references/creation-workflow.md`. Summary:

1. **Pick the right template** based on the agent's purpose
2. **Craft a detailed mission** from the user's description
3. **Choose settings** (model, max-turns, interval, workdir, claw sub-settings)
4. **Offer available skills** — run `list-skills`, suggest relevant ones
5. **Create the agent** via CLI and verify success
6. **Generate agent-specific skills** if needed
7. **Customize the CLAUDE.md** with domain knowledge
8. **Generate the agent's SKILL.md** for invocation from any session

### Which path?

- Vague or informal request → **Path A (`describe`)**
- Explicit template/turns/model in the request → **Path B (`create`)**
- User mentions timing ("daily", "every 6 hours", "9am weekdays") → either path, but Path A auto-schedules; Path B requires follow-up `schedule` call

## When the User Asks to Run/Manage Agents

- `run <name> [-m "<msg>"] [--fresh]` — execute agent and report results
- `continue <name> "<msg>"` — send follow-up to existing session
- `list` — show all agents
- `dashboard` — overview of all agents (status, costs, evals, running)
- `list-skills` — show available skills from ~/.claude/skills/
- `status <name>` — show detailed status
- `logs <name>` — show latest output
- `delete <name>` — confirm with user first, then delete

## When the User Asks to Schedule an Agent

Two scheduling mechanisms, **mutually exclusive** per agent:

### OS-level cron (new, preferred for time-of-day)
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs schedule <name> --cron "0 9 * * 1-5"
node ~/projects/agent-orchestrator/orchestrator.mjs schedule <name> --at "daily 09:00"
node ~/projects/agent-orchestrator/orchestrator.mjs schedule <name> --at "hourly"
node ~/projects/agent-orchestrator/orchestrator.mjs schedule <name> --at "weekdays 09:00"
node ~/projects/agent-orchestrator/orchestrator.mjs schedule <name> --remove
node ~/projects/agent-orchestrator/orchestrator.mjs schedule <name>           # show current
node ~/projects/agent-orchestrator/orchestrator.mjs schedule list             # show all scheduled
```
- macOS → per-agent launchd plist at `~/Library/LaunchAgents/com.agent-orchestrator.<name>.plist`
- Linux → user crontab line marked `# agent-orchestrator:<name>` (never touches unmarked lines)
- Survives reboots automatically (launchd loads at login; cron is always running)
- Install validates the plist via `plutil -lint` before loading — won't corrupt launchd state on a bug
- Refuses ambiguous cron→launchd translations (dom+dow, every-minute) rather than silently misscheduling
- Use `--force` only if the user explicitly wants to replace an existing daemon interval with cron

### Daemon interval (legacy, for "every N seconds" only)
- Set via `create --interval <seconds>` or later via editing `config.schedule.intervalSeconds`
- Requires `orchestrator daemon` to be running (systemd on Linux, manual `nohup`/launchd on Mac — daemon is NOT self-installing yet)
- **If user wants "9am daily" or any time-of-day pattern, use the cron path above, not the daemon interval**

### Picking between them
- "Run at 9am weekdays" / "daily at 3pm" / "hourly at :15" → **cron path**
- "Run every 30 minutes" / "every 6 hours" with no specific time → either works; cron is more portable and survives reboots without the daemon
- User already uses `orchestrator daemon` on my-linux-server → can coexist (different agents can use different mechanisms)

## When the User Asks to Improve/Optimize Agents

- `eval <name>` — evaluate latest run (LLM-as-judge, 5 dimensions)
- `audit <name>` — audit harness design quality
- `improve <name> [--apply]` — show/apply CLAUDE.md improvements from audit
- `autoresearch <name>` — automated run-eval-improve loop (Karpathy-style). Good for overnight optimization.
- `compete <name> [--variants N]` — fork N CLAUDE.md variants, run+eval all, pick winner
- `evolve <name> [--generations N]` — multi-generation genetic optimization (wraps compete)

## When the User Asks About Pipelines

- `pipeline validate <name>` — validate config without running
- `pipeline run <name>` — execute pipeline
- `pipeline status <run-id>` — show run details
- `pipeline list` — list all pipelines with recent runs

## Error Handling

- If `create` fails: check that the orchestrator exists at `~/projects/agent-orchestrator/` and Node.js >= 20 is available
- If `run` fails: check `status <name>` and `logs <name>` for details, report to user
- If the CLI is not found: inform the user to clone/install the orchestrator first
- If `list-skills` returns empty: proceed without skills, don't block agent creation
- If a pipeline stage fails: check `pipeline status <run-id>` for stage-level errors

## Important Rules

- Always confirm the agent configuration with the user before creating
- Pick sensible defaults — don't ask 10 questions when 1 will do
- After creating, show the user how to run it
- Never run the daemon without the user asking for it
- The orchestrator is at `~/projects/agent-orchestrator/orchestrator.mjs` — always use absolute paths
