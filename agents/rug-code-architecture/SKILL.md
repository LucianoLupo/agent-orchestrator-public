---
name: rug-code-architecture
description: Run the "rug-code-architecture" agent — Review ~/projects/rug-scanner architecture and code quality. Read ALL source files. Check: Is the Ho
---

# rug-code-architecture

Review ~/projects/rug-scanner architecture and code quality. Read ALL source files. Check: Is the Hono app properly structured? Is error handling consistent? Does Promise.allSettled degradation work correctly? Is the scorer logic sound (threshold-based verdicts)? Are types comprehensive? Is the cache layer correct (TTL, key format, invalidation)? Are there any circular dependencies? Is the x402 middleware configured correctly? Rate overall code quality 1-10 with specific issues.

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run rug-code-architecture
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/rug-code-architecture/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status rug-code-architecture
node ~/projects/agent-orchestrator/orchestrator.mjs logs rug-code-architecture
```
