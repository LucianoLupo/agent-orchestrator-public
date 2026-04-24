---
name: hlbot-performance-auditor
description: Run the "hlbot-performance-auditor" agent — Performance Auditor for Hyperliquid Trading Bot. Analyze: 1) Async/await patterns 2) Database/API ca
---

# hlbot-performance-auditor

Performance Auditor for Hyperliquid Trading Bot. Analyze: 1) Async/await patterns 2) Database/API call efficiency 3) Memory usage with pandas DataFrames 4) Caching opportunities 5) Concurrency bottlenecks 6) Hot paths in trading loop. Focus on src/main.py, src/trading/, src/indicators/. Report with impact and optimizations.

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run hlbot-performance-auditor
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/hlbot-performance-auditor/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status hlbot-performance-auditor
node ~/projects/agent-orchestrator/orchestrator.mjs logs hlbot-performance-auditor
```
