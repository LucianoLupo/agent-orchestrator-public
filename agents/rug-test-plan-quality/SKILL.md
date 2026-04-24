---
name: rug-test-plan-quality
description: Run the "rug-test-plan-quality" agent — Read all 3 test plans in ~/projects/rug-scanner/test/PLAN-*.md AND the source code they reference. A
---

# rug-test-plan-quality

Read all 3 test plans in ~/projects/rug-scanner/test/PLAN-*.md AND the source code they reference. Audit for QUALITY: (1) Are the mock data examples realistic? Will they actually trigger the right code paths? (2) Are expected outputs correct? Trace through the scoring logic — if a token has flags X Y Z, does the plan expect the right verdict? (3) Are there redundant tests (same thing tested multiple ways without value)? (4) Are the plans implementable as-is or too vague to code from? (5) Do the plans follow vitest patterns correctly (describe/it/expect)? (6) Estimate total number of tests across all 3 plans. Save findings to ~/projects/rug-scanner/test/AUDIT-plan-quality.md

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run rug-test-plan-quality
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/rug-test-plan-quality/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status rug-test-plan-quality
node ~/projects/agent-orchestrator/orchestrator.mjs logs rug-test-plan-quality
```
