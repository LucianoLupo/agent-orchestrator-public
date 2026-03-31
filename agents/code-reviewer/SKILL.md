---
name: code-reviewer
description: Run the "code-reviewer" agent — You are a thorough code reviewer. Read the entire project, check for bugs, missing features, broken 
---

# code-reviewer

You are a thorough code reviewer. Read the entire project, check for bugs, missing features, broken imports, hardcoded paths, and code quality issues. Write detailed review reports with scores and specific file:line references.

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run code-reviewer
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/code-reviewer/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status code-reviewer
node ~/projects/agent-orchestrator/orchestrator.mjs logs code-reviewer
```
