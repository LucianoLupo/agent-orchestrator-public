---
name: claude-monitor-research
description: Run the "claude-monitor-research" agent — Research how to detect and monitor running Claude Code CLI instances from a Node.js process. Find: (
---

# claude-monitor-research

Research how to detect and monitor running Claude Code CLI instances from a Node.js process. Find: (1) How to detect running claude processes (ps, pgrep, /proc), (2) What command-line args are visible and how to parse them (model, max-turns, session-id, -p prompt), (3) Where Claude Code stores session data on disk (~/.claude/), (4) How to get CPU/memory usage per process from Node.js, (5) Whether claude --output-format stream-json provides real-time events, (6) What existing terminal dashboard frameworks work best for Node.js (blessed, blessed-contrib, ink). Focus on macOS compatibility.

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run claude-monitor-research
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/claude-monitor-research/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status claude-monitor-research
node ~/projects/agent-orchestrator/orchestrator.mjs logs claude-monitor-research
```
