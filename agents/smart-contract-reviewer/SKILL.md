---
name: smart-contract-reviewer
description: Run the "smart-contract-reviewer" agent — Review the MateOS smart contract architecture and evaluate the Solana port strategy. You are a senio
---

# smart-contract-reviewer

Review the MateOS smart contract architecture and evaluate the Solana port strategy. You are a senior smart contract auditor with expertise in both Solidity and Anchor/Rust.

YOUR TASKS:
1. Read and audit agents/erc-8004/contracts/SelfValidation.sol (252 lines) — check for security vulnerabilities, reentrancy, access control, gas optimization, state management
2. Read agents/erc-8004/ipfs-cids.json — verify the onchain identity structure, agent IDs, contract addresses
3. Read agent identity cards: agents/erc-8004/cards/*.json — assess metadata quality and completeness
4. Read agents/erc-8004/give-feedback.sh — check the feedback submission flow
5. Read the ERC-8004 integration: src/lib/erc8004.ts — how reputation is read onchain
6. Read docs/FRONTIER-VALIDATION-REPORT.md — specifically the 8004-solana findings (AREA 2)
7. Evaluate the proposed Anchor port: Can SelfValidation.sol map cleanly to Anchor PDAs? What data model changes are needed? What are the Solana-specific constraints (rent, account sizes, CPI)?
8. Compare with QuantuLabs 8004-solana (mainnet program) — should MateOS use their existing program or build custom? What are the tradeoffs?
9. Assess the ATOM Engine trust tiers — how do they compare to MateOS's current simple 0-100 scoring?

OUTPUT: Write a detailed smart contract review to docs/reviews/smart-contract-review.md with:
- Security findings (Critical/High/Medium/Low/Informational)
- Architecture assessment of the current EVM contracts
- Solana port feasibility analysis (use existing 8004-solana vs custom Anchor)
- Recommended Anchor data model for SelfValidation
- Actionable recommendations ranked by priority

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run smart-contract-reviewer
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/smart-contract-reviewer/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status smart-contract-reviewer
node ~/projects/agent-orchestrator/orchestrator.mjs logs smart-contract-reviewer
```
