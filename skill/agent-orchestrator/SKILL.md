---
name: agent-orchestrator
description: Create, manage, and run autonomous agents via the Agent Orchestrator. Use when asked to "create an agent", "spawn an agent", "make an agent", "run agent", "list agents", "agent status", or any request to create autonomous workers for specific tasks.
---

# Agent Orchestrator Skill

You manage the Agent Orchestrator at `~/agent-orchestrator/`.

## Available Commands

```bash
# Agent lifecycle
node ~/agent-orchestrator/orchestrator.mjs create --name <n> --mission "<m>" [--template <t>] [--model <m>] [--max-turns <n>] [--interval <s>] [--workdir <path>] [--skills <s,s,...>] [--sub-model <m>] [--sub-max-turns <n>] [--workflow "<desc>"]
node ~/agent-orchestrator/orchestrator.mjs run <name> [-m "<msg>"] [--fresh]
node ~/agent-orchestrator/orchestrator.mjs continue <name> "<msg>"
node ~/agent-orchestrator/orchestrator.mjs list
node ~/agent-orchestrator/orchestrator.mjs list-skills
node ~/agent-orchestrator/orchestrator.mjs dashboard
node ~/agent-orchestrator/orchestrator.mjs status <name>
node ~/agent-orchestrator/orchestrator.mjs logs <name>
node ~/agent-orchestrator/orchestrator.mjs delete <name>
node ~/agent-orchestrator/orchestrator.mjs daemon [--max-concurrent <n>]

# Quality & optimization
node ~/agent-orchestrator/orchestrator.mjs eval <name>
node ~/agent-orchestrator/orchestrator.mjs audit <name>
node ~/agent-orchestrator/orchestrator.mjs improve <name> [--apply]
node ~/agent-orchestrator/orchestrator.mjs autoresearch <name> [--max-iterations N] [--cost-budget USD] [--min-improvement N] [-m "<task>"]
node ~/agent-orchestrator/orchestrator.mjs compete <name> [--variants N] [-m "<task>"]
node ~/agent-orchestrator/orchestrator.mjs evolve <name> [--generations N] [--variants N] [-m "<task>"]

# Pipelines
node ~/agent-orchestrator/orchestrator.mjs pipeline validate <name>
node ~/agent-orchestrator/orchestrator.mjs pipeline run <name>
node ~/agent-orchestrator/orchestrator.mjs pipeline status <run-id>
node ~/agent-orchestrator/orchestrator.mjs pipeline list
```

## Templates

- `default` — Generic autonomous agent
- `researcher` — Deep research with source integrity and verification loops
- `developer` — Code work with plan→execute→verify phases and git safety
- `claw` — Coordinator pattern: spawns sub-sessions for each step, reads results, loops

## When the User Asks to Create an Agent

**Your job is to be the intelligent layer.** The user will describe what they want casually. You must:

1. **Pick the right template** based on what the agent does:
   - Research, investigation, analysis → `researcher`
   - Code, review, audit, fix, build → `developer`
   - Multi-step workflows, orchestration, long-running tasks → `claw`
   - Anything else → `default`

2. **Craft a detailed mission** — expand the user's casual description into a specific, actionable mission statement. Include:
   - What the agent should focus on (specifics, not vague goals)
   - What outputs it should produce
   - What quality bar to meet
   - Any domain-specific knowledge it needs

3. **Choose appropriate settings:**
   - `--model`: `sonnet` for most tasks, `opus` for complex reasoning/architecture
   - `--max-turns`: 15 for focused tasks, 25 for medium, 40 for comprehensive
   - `--interval`: only if the user wants it scheduled
   - `--workdir`: if the agent works on a specific project
   - For `claw` template: set `--sub-model` (default: sonnet), `--sub-max-turns` (default: 100), and `--workflow` (describe the steps)

4. **Offer available skills** — before creating, run `list-skills` to see what's available, then ask the user:
   > "These skills are available to link to the agent: [list]. Want me to include any?"

   **Skill selection guidance** (suggest relevant ones, don't dump the whole list):
   - Agent does research → suggest: `deep-research`, `obsidian-expert`
   - Agent posts to Slack → suggest: `slack-api`
   - Agent monitors Twitter → suggest: `twitter-api`
   - Agent works with documents → suggest: `pdf`, `docx`, `pptx`
   - Agent generates videos/content → suggest: `youtube-wisdom`
   - Agent needs system cleanup → suggest: `mole-mac-cleaner`

   If the user says "no" or "none", skip. If they say "yes" or pick some, pass them via `--skills "name1,name2"`.

5. **Create the agent** via the CLI command

6. **Generate agent-specific skills** — after creating the agent, write custom skills to `~/agent-orchestrator/agents/<name>/skills/` if the agent needs specialized capabilities. Each skill is a markdown file with instructions the agent can follow.

7. **Customize the CLAUDE.md** — after creation, read and enhance the generated CLAUDE.md with:
   - Domain-specific knowledge relevant to the agent's mission
   - Custom verification criteria
   - Specific tools or commands the agent should use
   - Any reference material or URLs
   - If skills were linked, add a "## Available Skills" section listing them with brief descriptions

8. **Generate the agent's own SKILL.md** — write a SKILL.md to the agent's folder so it can be invoked from any Claude Code session. Use this format:

```markdown
---
name: <agent-name>
description: <one-line description of what this agent does and when to use it>
---

# <Agent Name>

Run this agent to <what it does>.

## Usage

To run this agent:
```bash
node ~/agent-orchestrator/orchestrator.mjs run <agent-name>
```

Or standalone:
```bash
~/agent-orchestrator/agents/<agent-name>/run.sh
```

## What It Does
<describe the agent's mission and what outputs it produces>

## When to Use
<describe scenarios when this agent should be invoked>
```

## When the User Asks to Run/Manage Agents

- `run <name> [-m "<msg>"] [--fresh]` — execute agent and report results
- `continue <name> "<msg>"` — send follow-up to existing session
- `list` — show all agents
- `dashboard` — overview of all agents (status, costs, evals, running)
- `list-skills` — show available skills from ~/.claude/skills/
- `status <name>` — show detailed status
- `logs <name>` — show latest output
- `delete <name>` — confirm with user first, then delete

## When the User Asks to Improve/Optimize Agents

- `eval <name>` — evaluate latest run (LLM-as-judge, 5 dimensions)
- `audit <name>` — audit harness design quality
- `improve <name> [--apply]` — show/apply CLAUDE.md improvements from audit
- `autoresearch <name>` — automated run→eval→improve loop (Karpathy-style). Good for overnight optimization.
- `compete <name> [--variants N]` — fork N CLAUDE.md variants, run+eval all, pick winner
- `evolve <name> [--generations N]` — multi-generation genetic optimization (wraps compete)

## When the User Asks About Pipelines

- `pipeline validate <name>` — validate config without running
- `pipeline run <name>` — execute pipeline
- `pipeline status <run-id>` — show run details
- `pipeline list` — list all pipelines with recent runs

## Important Rules

- Always confirm the agent configuration with the user before creating
- Pick sensible defaults — don't ask 10 questions when 1 will do
- After creating, show the user how to run it
- Never run the daemon without the user asking for it
- The orchestrator is at `~/agent-orchestrator/orchestrator.mjs` — always use absolute paths
