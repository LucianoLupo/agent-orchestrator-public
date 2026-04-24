---
name: rug-scanner-fixer
description: Run the "rug-scanner-fixer" agent — Fix all bugs found by the 5-agent audit of the rug-scanner project. You are a coordinator — spawn su
---

# rug-scanner-fixer

Fix all bugs found by the 5-agent audit of the rug-scanner project. You are a coordinator — spawn sub-sessions for each fix batch. Read all source files before making changes.

CRITICAL FIXES (Batch 1 — do first):

1. WRONG AERODROME FACTORY SELECTOR in src/analysis/liquidity.ts: Selector 0xcc56b2c5 is getFee(address,bool), NOT getPool(address,address,bool). Research the correct Aerodrome V2 factory selector for getPool(address,address,bool) on Base (factory: 0x420DD381b31aEf6683db6B902084cB0FFECe40Da). The correct selector for getPool(address,address,bool) should be computed from keccak256.

2. MISSING UNISWAP V3 ON BASE in src/analysis/liquidity.ts: Add Uniswap V3 factory address for Base chain (0x33128a8fC17869897dcE68Ed026d694621f6FDfD) alongside the existing Ethereum V3 factory.

3. WRONG AERODROME ROUTER ABI in src/providers/simulation.ts: The Aerodrome router uses different function signatures than Uniswap V2. Research the correct Aerodrome Router (0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43) swap function signature and fix the ABI encoding for trade simulation.

MEDIUM FIXES (Batch 2):

4. HARDCODED ETH PRICE: Replace any hardcoded ETH price with actual price from DEXScreener or Alchemy. The liquidity USD calculation should use real market data.

5. LP LOCK ADDRESSES ETHEREUM-ONLY: Add Base chain lock contract addresses for UNCX, Team Finance, etc. Research the correct Base mainnet addresses for these lock providers.

6. TOKEN DECIMAL ASSUMPTION: In liquidity calculation, read the actual decimals() from the token contract instead of assuming 1e18. Call the ERC20 decimals() function via RPC.

7. FALSE POSITIVE FEE SELECTORS: Remove the two incorrect selectors (cbccefb2 and aa4bde28) that are read-only getters, not fee setters. These cause false positives.

SECURITY FIXES (Batch 3):

8. SSRF IN URL CONSTRUCTION: In src/providers/dexscreener.ts and src/providers/explorer.ts, validate that tokenAddress matches /^0x[a-fA-F0-9]{40}$/ before interpolating into URLs.

9. API KEY IN ALCHEMY URL: Ensure Alchemy API key never appears in error messages. Wrap fetch calls to mask the URL in any thrown errors.

10. RATE LIMITING: Add basic rate limiting to the /scan endpoint (e.g., 10 req/sec per IP using a simple in-memory counter or Upstash Redis).

11. REQUEST TIMEOUTS: Add AbortController timeouts (5s) to all external fetch calls (Alchemy, DEXScreener, Basescan).

12. HTTP STATUS CODE CHECKING: All fetch() calls should check response.ok before calling response.json(). Return graceful degradation on 4xx/5xx.

RULES: Run tsc --noEmit after EACH batch to verify no type errors. Git commit after each batch. Do NOT break existing functionality — the 30 existing tests should still pass after fixes.

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run rug-scanner-fixer
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/rug-scanner-fixer/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status rug-scanner-fixer
node ~/projects/agent-orchestrator/orchestrator.mjs logs rug-scanner-fixer
```
