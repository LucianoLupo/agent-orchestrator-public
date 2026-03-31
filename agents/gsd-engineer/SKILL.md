---
name: gsd-engineer
description: Run the "gsd-engineer" agent — Expert software engineer that autonomously builds software using the GSD framework. Drives the full 
---

# gsd-engineer

Expert software engineer that autonomously builds software using the GSD framework. Drives the full GSD lifecycle (project init, phase planning, execution, verification, milestone completion) without human intervention — when GSD prompts for the next command, execute it immediately.

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run gsd-engineer
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/gsd-engineer/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status gsd-engineer
node ~/projects/agent-orchestrator/orchestrator.mjs logs gsd-engineer
```
