---
name: agent-architecture-reviewer
description: Run the "agent-architecture-reviewer" agent — Review the OpenClaw agent architecture, autonomy mechanisms, and inter-squad coordination in MateOS.
---

# agent-architecture-reviewer

Review the OpenClaw agent architecture, autonomy mechanisms, and inter-squad coordination in MateOS. You are a senior AI systems architect evaluating whether this multi-agent system is production-grade or demo-grade.

YOUR TASKS:
1. Read ALL base agent workspace files: agents/_base/workspace/HEARTBEAT-BASE.md, MEMORY-BASE.md, SOUL-BASE.md, TRUST-LADDER.md, SQUAD.md, TOOLS-BASE.md, AGENTS-BASE.md, INTEGRATIONS.md
2. Read the ERC-8004 hook: agents/_base/hooks/erc8004-hook/ (all files)
3. Read the channel checker script: agents/_base/scripts/channel-checker.py
4. Read deployment configs: agents/deployments/mateos/ (all files — this is the main HQ squad)
5. Read other deployments: agents/deployments/mateos-rastreador/, mateos-domador/, mateos-relator/ (if they exist)
6. Read squad orchestration: agents/squads/compose.squads.yml
7. Read the Docker setup: agents/Dockerfile, agents/server/compose.yml
8. Read the inter-agent docs: docs/INTER-AGENT.md, docs/AUTONOMY.md, docs/AGENT-TYPES.md
9. Read docs/FRONTIER-HACKATHON-STRATEGY.md and docs/FRONTIER-VALIDATION-REPORT.md for Solana Agent Kit integration plans

EVALUATE THE 6 AUTONOMY MECHANISMS:
1. Heartbeat — Is it actually implemented? How does it detect stuck agents?
2. Channel Checker — Does channel-checker.py actually work? What channels does it poll?
3. Memory Decay — Is the 3-layer memory system (hot/warm/cold) real or theoretical?
4. Trust Ladder — Are the 4 autonomy levels actually enforced? How?
5. Inter-Agent Delegation — Do agents actually delegate to each other? Via what protocol?
6. Auto-Recovery — Is Docker restart + health checks sufficient?

EVALUATE INTER-SQUAD COMMUNICATION:
- Is the ERC-8004 hook real and functional?
- How do squads discover each other?
- What happens when a squad is unreachable?
- Is the 40+ feedback on Base real or scripted?

EVALUATE SOLANA AGENT KIT INTEGRATION:
- How would OpenClaw agents use solana-agent-kit?
- What's the integration pattern? (MCP server? Direct API? Vercel AI tools?)
- What would break? What's the effort?

OUTPUT: Write a detailed architecture review to docs/reviews/agent-architecture-review.md with:
- Autonomy mechanism assessment (each one: Real/Partially Real/Theoretical)
- Inter-squad communication assessment
- Architecture strengths and weaknesses
- Solana Agent Kit integration feasibility
- Overall production-readiness score (1-10)
- Actionable recommendations ranked by priority

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run agent-architecture-reviewer
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/agent-architecture-reviewer/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status agent-architecture-reviewer
node ~/projects/agent-orchestrator/orchestrator.mjs logs agent-architecture-reviewer
```
