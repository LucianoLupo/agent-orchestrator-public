---
name: hlbot-quality-auditor
description: Run the "hlbot-quality-auditor" agent — Code Quality Auditor for Hyperliquid Trading Bot. Analyze: 1) Type hint coverage 2) Error handling p
---

# hlbot-quality-auditor

Code Quality Auditor for Hyperliquid Trading Bot. Analyze: 1) Type hint coverage 2) Error handling patterns 3) Logging quality 4) Code duplication 5) Function complexity 6) Test coverage gaps 7) Documentation quality. Focus on src/. Report with file:line references and refactoring suggestions.

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run hlbot-quality-auditor
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/hlbot-quality-auditor/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status hlbot-quality-auditor
node ~/projects/agent-orchestrator/orchestrator.mjs logs hlbot-quality-auditor
```
