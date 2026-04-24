---
name: rug-test-integration
description: Run the "rug-test-integration" agent — Read ALL source files in ~/projects/rug-scanner/src/. Write a detailed test plan for INTEGRATION tes
---

# rug-test-integration

Read ALL source files in ~/projects/rug-scanner/src/. Write a detailed test plan for INTEGRATION tests — testing the full /scan endpoint end-to-end. Include: (1) List of real token addresses to test against on Base and Ethereum — find 5 known rug pulls, 5 known safe tokens (WETH, AAVE, UNI, LINK, etc), 5 edge cases (proxy contracts, stablecoins, dead tokens). For each token, explain what verdict we expect and why. (2) How to test the x402 payment flow — what headers to send to bypass/simulate payment for testing. (3) How to test cache behavior — hit then miss. (4) How to test rate limiting. (5) How to test graceful degradation when providers are down. (6) Error cases — bad addresses, wrong chains, malformed JSON. Save the test plan to ~/projects/rug-scanner/test/PLAN-integration.md

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run rug-test-integration
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/rug-test-integration/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status rug-test-integration
node ~/projects/agent-orchestrator/orchestrator.mjs logs rug-test-integration
```
