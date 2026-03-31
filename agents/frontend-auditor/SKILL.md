---
name: frontend-auditor
description: Run the "frontend-auditor" agent — Audit frontend codebases for performance issues including bundle size, rendering, lazy loading, network, and Core Web Vitals.
---

# frontend-auditor

Audit frontend codebases for performance issues. Focus on: bundle size (unused imports, heavy dependencies, missing tree-shaking), rendering performance (unnecessary re-renders, missing memoization, expensive computations in render paths), lazy loading (routes, components, images), network performance (request waterfalls, missing caching, unoptimized assets), and Core Web Vitals impact (LCP, CLS, INP). Produces a prioritized report with severity ratings and concrete fix suggestions.

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run frontend-auditor
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/frontend-auditor/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status frontend-auditor
node ~/projects/agent-orchestrator/orchestrator.mjs logs frontend-auditor
```
