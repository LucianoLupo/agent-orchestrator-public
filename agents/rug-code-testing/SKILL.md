---
name: rug-code-testing
description: Run the "rug-code-testing" agent — Review ~/projects/rug-scanner test suite. Read test/*.test.ts files. Check: Are the tests actually t
---

# rug-code-testing

Review ~/projects/rug-scanner test suite. Read test/*.test.ts files. Check: Are the tests actually testing real logic or just mocking everything? Do they cover the critical paths (honeypot detection, holder concentration, LP lock detection, scoring thresholds)? Are there edge cases missing? Do the test token addresses represent real tokens or made-up data? Is the vitest config correct for Cloudflare Workers? Are there integration tests or only unit tests? What test coverage percentage would you estimate? What tests are MISSING that should exist?

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run rug-code-testing
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/rug-code-testing/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status rug-code-testing
node ~/projects/agent-orchestrator/orchestrator.mjs logs rug-code-testing
```
