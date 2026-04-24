# Agent Creation Workflow

When the user asks to create an agent, follow these 8 steps. **Your job is to be the intelligent layer** — the user will describe what they want casually, and you translate that into a well-configured agent.

## Step 1: Pick the Right Template

Based on what the agent does:
- Research, investigation, analysis → `researcher`
- Code, review, audit, fix, build → `developer`
- Multi-step workflows, orchestration, long-running tasks → `claw`
- Anything else → `default`

## Step 2: Craft a Detailed Mission

Expand the user's casual description into a specific, actionable mission statement. Include:
- What the agent should focus on (specifics, not vague goals)
- What outputs it should produce
- What quality bar to meet
- Any domain-specific knowledge it needs

## Step 3: Choose Appropriate Settings

- `--model`: `sonnet` for most tasks, `opus` for complex reasoning/architecture
- `--max-turns`: 15 for focused tasks, 25 for medium, 40 for comprehensive
- `--interval`: only if the user wants it scheduled
- `--workdir`: if the agent works on a specific project
- For `claw` template: set `--sub-model` (default: sonnet), `--sub-max-turns` (default: 100), and `--workflow` (describe the steps)

## Step 4: Offer Available Skills

Before creating, run `list-skills` to see what's available, then ask:
> "These skills are available to link to the agent: [list]. Want me to include any?"

**Skill selection guidance** (suggest relevant ones, don't dump the whole list):
- Agent does research → suggest: `deep-research`, `obsidian-expert`
- Agent posts to Slack → suggest: `slack-api`
- Agent monitors Twitter → suggest: `twitter-api`
- Agent works with documents → suggest: `pdf`, `docx`, `pptx`
- Agent generates videos/content → suggest: `youtube-wisdom`
- Agent needs system cleanup → suggest: `mole-mac-cleaner`

If the user says "no" or "none", skip. If they say "yes" or pick some, pass them via `--skills "name1,name2"`.

## Step 5: Create the Agent

Run the CLI `create` command with all chosen parameters. Verify the command exits successfully before proceeding.

## Step 6: Generate Agent-Specific Skills

After creating, write custom skills to `~/projects/agent-orchestrator/agents/<name>/skills/` if the agent needs specialized capabilities. Each skill is a markdown file with instructions the agent can follow.

## Step 7: Customize the CLAUDE.md

Read and enhance the generated CLAUDE.md with:
- Domain-specific knowledge relevant to the agent's mission
- Custom verification criteria
- Specific tools or commands the agent should use
- Any reference material or URLs
- If skills were linked, add a "## Available Skills" section listing them with brief descriptions

## Step 8: Generate the Agent's SKILL.md

Write a SKILL.md to the agent's folder so it can be invoked from any Claude Code session:

```markdown
---
name: <agent-name>
description: <one-line description of what this agent does and when to use it>
---

# <Agent Name>

Run this agent to <what it does>.

## Usage

To run this agent:
\```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run <agent-name>
\```

Or standalone:
\```bash
~/projects/agent-orchestrator/agents/<agent-name>/run.sh
\```

## What It Does
<describe the agent's mission and what outputs it produces>

## When to Use
<describe scenarios when this agent should be invoked>
```
