---
name: rug-code-correctness
description: Run the "rug-code-correctness" agent — Review ~/projects/rug-scanner for correctness of on-chain analysis. Read src/analysis/*.ts and src/p
---

# rug-code-correctness

Review ~/projects/rug-scanner for correctness of on-chain analysis. Read src/analysis/*.ts and src/providers/*.ts carefully. Check: Does contract.ts correctly extract function selectors via EVMole? Does it properly detect EIP-1967 proxy slots? Does holders.ts correctly sample Transfer events and calculate concentration? Does liquidity.ts correctly discover pools on Uniswap V2, V3, AND Aerodrome? Are the factory addresses correct for Base and Ethereum? Does simulation.ts correctly simulate swaps through the right routers? Are there any math errors in tax calculation? Does deployer.ts correctly find the deployer address? Does explorer.ts use the right Basescan/Etherscan API endpoints?

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run rug-code-correctness
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/rug-code-correctness/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status rug-code-correctness
node ~/projects/agent-orchestrator/orchestrator.mjs logs rug-code-correctness
```
