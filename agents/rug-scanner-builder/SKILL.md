---
name: rug-scanner-builder
description: Run the "rug-scanner-builder" agent — Build the rug-scanner project from start to finish following PLAN.md (v3). You are a coordinator age
---

# rug-scanner-builder

Build the rug-scanner project from start to finish following PLAN.md (v3). You are a coordinator agent. For each phase, spawn a fresh claude sub-session to do the work. Read PLAN.md first for full architecture, file structure, and implementation details.

PHASES (execute ALL of them, one sub-session per phase):

PHASE 1 - SCAFFOLDING: Init Hono + TypeScript project, package.json with deps (hono, @x402/hono, viem, evmole, zod, @upstash/redis), tsconfig.json, wrangler.toml, create full file structure from PLAN.md. Set up x402 middleware, Zod validation, Redis cache, types. Git init + commit.

PHASE 2 - ANALYSIS ENGINE: Build src/analysis/contract.ts (EVMole bytecode selector extraction for mint/blacklist/pause + EIP-1967 proxy detection + ownership check), src/analysis/holders.ts (sample Transfer events via Alchemy getAssetTransfers + balanceOf top addresses), src/analysis/deployer.ts (wallet age, tx count, balance), src/providers/explorer.ts (Basescan source verification). Git commit.

PHASE 3 - LIQUIDITY + SIMULATION: Build src/analysis/liquidity.ts (pool discovery via Uniswap V2/V3 Factory + Aerodrome Factory on Base, LP reserves, LP lock check against UNCX/Team Finance addresses), src/providers/simulation.ts (buy/sell tax simulation via eth_call through Uniswap/Aerodrome router). If simulation is too complex, skip it and note in code. Git commit.

PHASE 4 - SCORING + INTEGRATION: Build src/analysis/scorer.ts (threshold-based verdicts, NO weights — if cant_sell CRITICAL, if deployer_majority HIGH_RISK, etc), wire everything into src/index.ts /scan endpoint with parallel Promise.allSettled fetching, DEXScreener integration, confidence calculation, response formatting with disclaimer. Git commit.

PHASE 5 - TESTING: Create test/known-rugs.test.ts, test/known-safe.test.ts, test/edge-cases.test.ts with real token addresses. Run tests. Fix any issues. Git commit.

RULES: Read PLAN.md before ANY work. NO GoPlus, NO Honeypot.is. Threshold verdicts, NO weighted scores, NO LLM. Base + Ethereum only. Support Aerodrome on Base. Run tsc after each phase. Git commit after each phase. DO NOT STOP until all 5 phases are complete.

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run rug-scanner-builder
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/rug-scanner-builder/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status rug-scanner-builder
node ~/projects/agent-orchestrator/orchestrator.mjs logs rug-scanner-builder
```
