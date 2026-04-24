---
name: rug-test-analysis
description: Run the "rug-test-analysis" agent — Read ALL files in ~/projects/rug-scanner/src/analysis/. Write a detailed test plan for UNIT tests of
---

# rug-test-analysis

Read ALL files in ~/projects/rug-scanner/src/analysis/. Write a detailed test plan for UNIT tests of the analysis modules. For each module: (1) contract.ts — test bytecode selector detection for mint/blacklist/pause/proxy/fee. What bytecode patterns to mock? How to test EIP-1967 proxy detection? How to test ownership check? (2) holders.ts — test concentration calculation with mock transfer events. Edge cases: tokens with 0 holders, tokens with millions of transfers, deployer not found. (3) deployer.ts — test wallet age calculation, tx count, balance. Edge case: contract deployed by another contract. (4) liquidity.ts — test pool discovery for Uniswap V2, V3, and Aerodrome. Test LP lock detection with mock balanceOf calls. Test ETH price fetching. (5) scorer.ts — already tested but verify threshold logic is complete. For each test, specify the mock data and expected output. Save to ~/projects/rug-scanner/test/PLAN-analysis.md

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run rug-test-analysis
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/rug-test-analysis/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status rug-test-analysis
node ~/projects/agent-orchestrator/orchestrator.mjs logs rug-test-analysis
```
