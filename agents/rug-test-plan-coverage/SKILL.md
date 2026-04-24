---
name: rug-test-plan-coverage
description: Run the "rug-test-plan-coverage" agent — Read ALL source files in ~/projects/rug-scanner/src/ AND all 3 test plans in ~/projects/rug-scanner/
---

# rug-test-plan-coverage

Read ALL source files in ~/projects/rug-scanner/src/ AND all 3 test plans in ~/projects/rug-scanner/test/PLAN-*.md. Audit for COVERAGE GAPS: What code paths have NO planned tests? What edge cases are missing? What failure modes are untested? Cross-reference every function exported from every .ts file against the test plans. Report: (1) Functions with zero test coverage planned. (2) Error branches not tested. (3) Missing edge cases (empty responses, timeouts, malformed data). (4) Are the real token addresses in the integration plan actually valid and on the right chains? Save findings to ~/projects/rug-scanner/test/AUDIT-coverage-gaps.md

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run rug-test-plan-coverage
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/rug-test-plan-coverage/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status rug-test-plan-coverage
node ~/projects/agent-orchestrator/orchestrator.mjs logs rug-test-plan-coverage
```
