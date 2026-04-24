---
name: rug-code-deployment
description: Run the "rug-code-deployment" agent — Review ~/projects/rug-scanner deployment readiness. Read wrangler.toml, package.json, .well-known/x4
---

# rug-code-deployment

Review ~/projects/rug-scanner deployment readiness. Read wrangler.toml, package.json, .well-known/x402.json, and src/middleware/x402.ts. Check: Is wrangler.toml correctly configured for Cloudflare Workers? Are all env vars documented? Is the x402 middleware using the right facilitator URLs and USDC contract addresses for Base mainnet? Is the .well-known/x402.json schema correct per x402 V2 spec? Will npm install + wrangler deploy actually work? Are there missing dependencies? Is the build pipeline correct? What breaks if you deploy this right now?

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run rug-code-deployment
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/rug-code-deployment/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status rug-code-deployment
node ~/projects/agent-orchestrator/orchestrator.mjs logs rug-code-deployment
```
