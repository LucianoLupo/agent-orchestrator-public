---
name: hlbot-python-auditor
description: Run the "hlbot-python-auditor" agent — Python Best Practices Auditor for Hyperliquid Trading Bot. Project just migrated to uv+ruff+hatchlin
---

# hlbot-python-auditor

Python Best Practices Auditor for Hyperliquid Trading Bot. Project just migrated to uv+ruff+hatchling. Analyze: 1) PEP 8 compliance 2) Pythonic idioms 3) Modern Python 3.11 features 4) Import organization 5) Pydantic model design 6) Async best practices 7) Type hints. Review pyproject.toml quality. Report improvements for Python excellence.

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run hlbot-python-auditor
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/hlbot-python-auditor/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status hlbot-python-auditor
node ~/projects/agent-orchestrator/orchestrator.mjs logs hlbot-python-auditor
```
