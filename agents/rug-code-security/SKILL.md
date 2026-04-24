---
name: rug-code-security
description: Run the "rug-code-security" agent — Review ~/projects/rug-scanner for security vulnerabilities. Check: SSRF in provider calls (alchemy.t
---

# rug-code-security

Review ~/projects/rug-scanner for security vulnerabilities. Check: SSRF in provider calls (alchemy.ts, dexscreener.ts, explorer.ts, simulation.ts), input validation on token addresses and chain params, x402 wallet address injection, private key exposure in env vars, prompt injection if LLM is ever added. Check for unsafe string interpolation in RPC URLs. Review the simulation.ts eth_call construction for injection vectors. Report every finding with file:line and severity.

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run rug-code-security
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/rug-code-security/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status rug-code-security
node ~/projects/agent-orchestrator/orchestrator.mjs logs rug-code-security
```
