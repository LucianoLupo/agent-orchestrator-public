---
name: test-worker-2
description: Run the "test-worker-2" agent — Lightweight test agent for pipeline smoke tests — secondary worker for parallel stages
---

# test-worker-2

Lightweight test agent for pipeline smoke tests — secondary worker for parallel stages

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run test-worker-2
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/test-worker-2/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status test-worker-2
node ~/projects/agent-orchestrator/orchestrator.mjs logs test-worker-2
```
