---
name: rug-test-providers
description: Run the "rug-test-providers" agent — Read ALL files in ~/projects/rug-scanner/src/providers/. Write a detailed test plan for UNIT tests o
---

# rug-test-providers

Read ALL files in ~/projects/rug-scanner/src/providers/. Write a detailed test plan for UNIT tests of the provider modules. For each: (1) alchemy.ts — test RPC call construction, error handling, timeout behavior, API key masking in errors. Mock responses for eth_call, eth_getBalance, eth_getTransactionCount, eth_getCode, getAssetTransfers. (2) dexscreener.ts — test response parsing, handling of null pairs, multi-chain filtering, SSRF validation on addresses. (3) explorer.ts — test Basescan vs Etherscan URL selection, verified/unverified parsing, SSRF validation, rate limit handling. (4) simulation.ts — test swap simulation encoding for Uniswap V2, V3, and Aerodrome routers. Test tax calculation from getAmountsOut response. Test honeypot detection (reverted calls). For each test, specify exact mock request/response data. Save to ~/projects/rug-scanner/test/PLAN-providers.md

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run rug-test-providers
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/rug-test-providers/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status rug-test-providers
node ~/projects/agent-orchestrator/orchestrator.mjs logs rug-test-providers
```
