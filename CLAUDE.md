# Agent Orchestrator (Private)

Zero-dependency, single-file Node.js CLI + daemon that creates, runs, evaluates, and evolves autonomous Claude Code agents. Pipelines, supervisor gates, autoresearch loops, genetic optimization. 2,785 lines, 188 tests.

**Tech Stack:** Node.js (>=20), zero dependencies, Claude Code CLI

**Last Updated:** 2026-03-31

---

## Architecture

Single file (`orchestrator.mjs`) with all logic. Agents spawned via `claude` CLI. State persisted as JSON with atomic writes (tmp-then-rename). Safety enforced via hooks and env vars (policy-as-architecture), not prompts.

```
orchestrator.mjs          # Core engine (2,785 lines)
orchestrator.test.mjs     # 188 tests
agents/                   # Agent instances
pipelines/                # Pipeline definitions
templates/                # Agent CLAUDE.md templates (default, developer, researcher, claw, judge)
shared/                   # Hooks, skills, rules
systemd/                  # Daemon service file
scripts/                  # Release tooling
```

---

## Public Release Process

The public repo lives at: https://github.com/LucianoLupo/agent-orchestrator-public

### How It Works

This repo (private) is the source of truth. A release script syncs safe content to a separate public repo, excluding sensitive agents and scrubbing private references.

**Key files:**
- `.release-exclude` — Lists agents/dirs to exclude from public release
- `scripts/release-public.sh` — Sync script (rsync + scrub + verify)

### Excluded from Public

**Agents** — company/product-specific agents are excluded. The authoritative list is in `.release-exclude`. Categories include: product-QA agents, crypto/security audits, MVP specs, data-analysis agents for private projects, and PR-testing tooling.

**Directories:**
- `.planning/` — Internal project management
- `.claude/` — Private memory/config

Add new private-agent directory names to `.release-exclude` (one per line) before running the release script.

### What Gets Scrubbed

The release script automatically:
1. Replaces hard-coded home-directory paths with `$HOME` in all agent files
2. Genericizes company / product-brand strings in example agents (e.g. brand names → neutral placeholders)
3. Generalizes absolute project paths used in examples (e.g. company repos → placeholder paths)
4. Removes personal server hostnames from docs and plans
5. Genericizes example agent names used in the describe-prompt template and plan files
6. Neutralizes historical launchd label prefixes in preserved smoke-test logs
7. Scans for an extensive list of sensitive patterns and fails if any leak is detected — see `scripts/release-public.sh` for the authoritative list

### Publishing a New Release

```bash
# 1. Run the release script (from this repo)
./scripts/release-public.sh

# 2. Commit and push in the public repo
cd ../agent-orchestrator-public
git add -A && git commit -m "Release vX.Y.Z"
git push
```

### Adding a New Sensitive Agent

If you create an agent that shouldn't be public, add its directory name to `.release-exclude`:
```
# In .release-exclude, under the agents section:
my-private-agent
```

Then re-run the release script — it will be excluded automatically.

---

## Getting Started

```bash
node orchestrator.mjs create --name my-agent --mission "Do something" --template default
node orchestrator.mjs run my-agent
node orchestrator.mjs daemon          # Start scheduler
node --test orchestrator.test.mjs     # Run tests
```

---

## Milestones

- **v1.0** (2026-03-22): Production hardening — daemon correctness, reliability, cost controls
- **v2.0** (2026-03-23): Pipeline orchestration — supervisor gates, crash-safe state, data flow
- **v2.0.1** (2026-03-24): Observability — activity tracking, gate enrichment
- **v2.1** (2026-03-24): Parallel execution, autoresearch loop, dashboard
- **v3.0** (2026-03-25): Claw template, variant competition, genetic optimization
