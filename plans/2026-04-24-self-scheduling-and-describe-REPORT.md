# Self-Scheduling + NL Agent Generation — Verification Report

**Date:** 2026-04-24
**Reviewer:** docs-and-review (Wave 3)
**Plan:** plans/2026-04-24-self-scheduling-and-describe.md
**Waves:** 1 (schedule) + 2 (describe) landed; this report covers the combined feature.

## Summary

Both new commands work end-to-end and ship with full test coverage. Wave 1 (`orchestrator schedule`) installs native cron entries on macOS (launchd plist) and Linux (user crontab) with per-agent markers so install/remove never touches unrelated entries. Wave 2 (`orchestrator describe`) turns a one-sentence description into a fully wired, bootstrapped, scheduled agent by composing existing primitives (`parseDescription`, `createAgent`, `auditAgent`, `improveAgent`, `scheduleInstall`) with an LLM-backed intent parser, an audit → improve bootstrap loop capped by iterations and USD budget, and a native OS schedule install. Test count rose from 193 → 221 (+28: 13 SCHED-* + 15 DESC-* plus source-sanity checks). 67/0 shell hook assertions still green. The three known unused-symbol diagnostics introduced by Waves 1 and 2 were cleaned up in this wave. Overall verdict: **PASS** — ready to commit.

## Test results

| Suite | Before Wave 1 | After Wave 2 + cleanup | Delta |
|-------|---------------|-----------------------|-------|
| `orchestrator.test.mjs` | 193 pass / 0 fail | **221 pass / 0 fail** | +28 |
| `shared/hooks/__tests__/test-hooks.sh` | 67 pass / 0 fail | **67 pass / 0 fail** | 0 |

JS test duration: ~310 ms. All three post-cleanup runs confirmed green; no flakes.

## Feature checklist

### Wave 1 — `orchestrator schedule` (cron-based scheduling)

| Item | Where | Status |
|------|-------|--------|
| `schedule <name> --cron "<expr>"` install | `orchestrator.mjs:3294 scheduleCommand` → `3351 scheduleInstall` | PASS |
| `schedule <name> --at "<sugar>"` sugar expansion | `expandScheduleSugar` (orchestrator.mjs:2860) — supports `hourly`, `daily HH:MM`, `weekdays HH:MM`, `weekly <dow> HH:MM` | PASS |
| `schedule <name> --remove` idempotent uninstall | `scheduleRemove` (orchestrator.mjs:3389) | PASS |
| `schedule <name>` show current + OS artifact | `scheduleShow` (orchestrator.mjs:3418) | PASS |
| `schedule list` list all scheduled agents | `scheduleList` (orchestrator.mjs:3451) | PASS |
| macOS launchd install (plist + `launchctl bootstrap`) | `installLaunchd` + `cronToLaunchdPlist` (orchestrator.mjs:3001/3068/3191) | PASS |
| Linux user-crontab install (marker-line round-trip) | `installCrontab` + `buildCrontabLine` / `stripCrontabForAgent` (orchestrator.mjs:3248/~3230) | PASS |
| Per-agent label `com.agent-orchestrator.<name>` / `# agent-orchestrator:<name>` | Used consistently across all install/remove/show paths | PASS |
| Mutual exclusivity with `intervalSeconds` + `--force` override | `scheduleInstall` guard at orchestrator.mjs:3358 | PASS |
| Cron expression validation (5 fields, range checks) | `validateCronExpr` (orchestrator.mjs:2945) | PASS |
| Unit tests (SCHED-*) | orchestrator.test.mjs — 13 tests covering sugar expansion, cron validation, launchd dict generation, crontab line round-trip, mutual exclusivity, idempotent remove | PASS |

### Wave 2 — `orchestrator describe` (NL → scheduled agent)

| Item | Where | Status |
|------|-------|--------|
| Meta-prompt template | `templates/meta/describe-prompt.md` (NEW, 73 lines, generic) | PASS |
| `describe "<nl>"` CLI command | orchestrator.mjs:3807 case `"describe"` | PASS |
| Intent parsing via Haiku → JSON spec | `parseDescription` (orchestrator.mjs, exported) | PASS |
| JSON spec validation | `validateDescribeSpec` (name kebab-case, template enum, maxTurns bounds, model enum, workdir absolute, schedule shape) | PASS |
| Interactive confirmation unless `--yes` | `_testSetPromptConfirm` / `_testResetPromptConfirm` — pluggable readline, zero-dep | PASS |
| Agent creation reuses existing `createAgent` | No changes to `createAgent` needed — parsed spec flows through cleanly | PASS |
| Bootstrap loop (audit → improve → re-audit) | `bootstrapAgent` (orchestrator.mjs, exported); stops on score ≥ 6, maxIterations, or budget | PASS |
| Cost-budget guard across parse + bootstrap | `totalCost` accumulator; bootstrap receives `Math.max(0, costBudget - totalCost)` | PASS |
| Schedule install via Wave 1 primitive | orchestrator.mjs:988 calls `scheduleInstall(spec.name, cronExpr, { force: false })` | PASS |
| `--dry-run`, `--no-bootstrap`, `--no-schedule`, `--max-iterations`, `--cost-budget`, `--model` flags | All honored; verified by DESC-* tests | PASS |
| Unit tests (DESC-*) | orchestrator.test.mjs — 15 tests covering JSON extraction, spec validation, parse success/failure, bootstrap stop conditions (score/budget/iterations), end-to-end with `--yes` | PASS |

## Smoke test records

### Wave 1 — macOS launchd smoke (from `scheduler-builder` transcript)

- Created throwaway agent `sched-smoke-test`.
- `schedule sched-smoke-test --cron "0 9 * * 1-5"`:
  - Plist written to `~/Library/LaunchAgents/com.agent-orchestrator.sched-smoke-test.plist`.
  - `plutil -lint` passed.
  - `launchctl bootstrap gui/<uid>` loaded the agent; `launchctl list | grep agent-orchestrator` showed the label.
  - `config.schedule.cron` persisted as `"0 9 * * 1-5"`, `platform = "darwin"`, ISO `installedAt` present.
- `schedule sched-smoke-test`:
  - Printed cron, platform, install timestamp, plist path, and `Plist exists: yes`.
- `schedule sched-smoke-test --remove`:
  - Ran `launchctl bootout` then deleted the plist.
  - Config `schedule.cron / installedAt / platform` removed; `intervalSeconds` (none) preserved correctly.
  - `launchctl list | grep agent-orchestrator` empty afterwards.
- Second `--remove` call (idempotency check): no error, no-op message.

### Wave 2 — real-cost describe smoke (from `describe-builder` transcript)

Ran against live Claude (Haiku for parse, Sonnet for audit + improve) with `--cost-budget 0.5`:

```
describe "Dummy test agent that does nothing, runs hourly"
```

- Parse step: Haiku returned a valid spec (`template: developer`, `schedule.at: "hourly"`, `maxTurns: 10`) at ~$0.0012.
- Interactive confirm shown; `--yes` skipped prompt in smoke run.
- `createAgent` produced `agents/dummy-test/` with CLAUDE.md, config.json, SKILL.md, `.claude/settings.json`.
- Bootstrap loop: 1 iteration, `domain_encoding` 1 → 6, stopped on score threshold, bootstrap cost ≈ $0.11.
- Schedule install: sugar `"hourly"` → cron `0 * * * *` → launchd plist installed at `com.agent-orchestrator.dummy-test.plist`, verified present with `launchctl list`.
- Final summary totals: **$0.1067 spent / $0.50 budget**.
- Cleanup: `schedule dummy-test --remove` + `delete dummy-test`; plist gone, agent dir gone.

Both smokes confirm end-to-end correctness on macOS. Linux crontab path is covered by unit tests (`buildCrontabLine`, `stripCrontabForAgent` round-trip) but was not exercised by a live smoke — flagged as a follow-up below.

## TypeScript diagnostics

Three unused-symbol diagnostics introduced by Waves 1 and 2 were cleaned up in this wave:

| File:Line (before) | Symbol | Resolution |
|--------------------|--------|------------|
| `orchestrator.mjs:30` | `dirname` imported from `node:path` but never used | Removed from import statement |
| `orchestrator.mjs:3024` | `const buildDict` in `cronToLaunchdInterval` — dead helper left over from an earlier implementation; the cartesian-product loop below builds dicts inline | Removed; comment above the loop kept and shortened |
| `orchestrator.test.mjs:3161` | `const originalBootstrap = bootstrapAgent;` — save-and-restore pattern never completed; the finally block only reset the spawnClaude mock | Removed (dead); stale comment "Keep the count low…" removed with it |

All three removals are genuinely dead code (verified via grep across the whole file for each symbol). Post-cleanup test run: 221/221 green.

**Not touched** (per explicit plan constraint): the "This may be converted to an async function" suggestion on `orchestrator.mjs:2635` is a pre-existing style hint, not a real issue; left alone.

**Pre-existing diagnostics** (from the prior wave's report, still open): none re-introduced by this feature. The unused-import cleanup in `orchestrator.test.mjs:7` from 2026-04-23 is intact.

## `.release-exclude` check

Read `.release-exclude` and `scripts/release-public.sh`. Assessment:

- `templates/meta/describe-prompt.md` — generic meta-prompt, no private references. Safe to include publicly.
- New code in `orchestrator.mjs` — the launchd plist label is `com.agent-orchestrator.<name>` (neutral reverse-DNS, safe for public release). See "Addendum" below: the prefix was renamed from the earlier `com.agent-orchestrator.` during the 2026-04-24 follow-up pass.
- No hardcoded paths (`$HOME`, `/projects/my-app`, etc.) or API keys found in the new code.

## Open follow-ups

1. **Bootstrap loop defaults (medium priority).** Current default is `--max-iterations 2` and `--cost-budget 1.0`. Real smoke hit the score threshold after 1 iteration for a trivial agent; unknown whether 2 iterations is enough for more complex missions to reach `domain_encoding ≥ 6`. Worth a session that runs `describe` against 3-5 representative missions and tunes the defaults based on observed cost / final score distribution.

2. **`describe list` subcommand (low priority).** Deferred during Wave 2 planning. Users can combine `list` + `schedule list` or grep output to find describe-generated agents (they have no distinguishing marker in config.json today). If it becomes friction, add a `config.createdBy: "describe"` field at create time and surface it via `describe list`.

3. **Time zone documentation (low priority).** All schedules run in local system time. No helper for "UTC 9am" or "America/Buenos_Aires 9am" — users need to shift their cron manually or set `CRON_TZ=` in their crontab (Linux only; macOS launchd has no analogous field). README now notes this; a richer section with worked examples would help anyone running the orchestrator across multiple hosts in different zones.

4. **Cron expression quick-reference in `schedule --help` (nice-to-have).** `expandScheduleSugar` accepts `hourly / daily HH:MM / weekdays HH:MM / weekly <dow> HH:MM` but these are only discoverable by reading the code or the README. Adding a couple of example lines to the error message thrown by `validateCronExpr` on bad input would save repeat lookups.

5. **`launchctl bootstrap` vs `launchctl load` fallback path (medium priority).** On modern macOS (12+) the install uses `bootstrap gui/<uid>`. There is fallback logic to `launchctl load` for older macOS, but only the primary path is exercised in the live smoke. If Apple ever removes `bootstrap` semantics or if someone runs the orchestrator on a surprisingly old macOS, the fallback may have latent bugs. Worth a defensive test that mocks `launchctl bootstrap` returning non-zero and asserts the fallback path is taken.

6. **Label prefix (release hygiene).** ~~Neutralize `com.lupo.` → `com.agent-orchestrator.` before the next public release.~~ **Closed** in the 2026-04-24 follow-up pass — see Addendum.

7. **Linux crontab live smoke (low priority).** Unit tests cover line construction and round-trip removal deterministically, but the command has never been exercised against a real `crontab -l` / `crontab -` pipe. Next time the orchestrator is touched on `my-linux-server` (or any Linux box), run `schedule --at hourly` + `--remove` as a 5-minute validation.

## Recommendation

**Ready to commit.** 221/221 tests green, 67/0 shell hooks green, three dead-code diagnostics cleaned up, README updated with `Describe` and `Scheduling` sections plus an updated CLI Reference block, no pre-existing diagnostics re-introduced, no secrets or private paths in the new code. The earlier `com.lupo.` label prefix was renamed to `com.agent-orchestrator.` in the 2026-04-24 follow-up pass (see Addendum).

Suggested commit message:

```
feat(schedule+describe): cron scheduling and NL-to-agent generation

Wave 1: orchestrator schedule <name> --cron/--at/--remove/list
  launchd on macOS, user crontab on Linux, per-agent labels.
Wave 2: orchestrator describe "<nl>" parses intent via Haiku,
  creates agent, runs audit→improve bootstrap loop, installs schedule.
Wave 3: docs + dead-code cleanup (dirname import, buildDict,
  originalBootstrap), README Scheduling + Describe sections, REPORT.

Tests: 221/221 pass (+28 new: 13 SCHED-*, 15 DESC-*). Shell hook
suite still 67/0. Smoke: macOS launchd install+remove, live describe
at $0.11 / $0.50 budget, domain_encoding 1→6 in one bootstrap iter.
```

## Addendum: Follow-up items closed (2026-04-24)

Items 1 (bootstrap loop defaults tuning) and 7 (Linux crontab live smoke on my-linux-server) are tracked separately and not addressed in this pass. Items 2–6 are closed below; test count 221 → 226 (+5: DESC-11, DESC-12, SCHED-14, SCHED-15, SCHED-16). Shell hook suite still 67/0.

- **Item 2 — `describe list` + `createdBy` marker:** extended `createAgent` to accept a `createdBy` option; `describeAgent` passes `createdBy: "describe"`. New `describeList` function exported, wired to `orchestrator describe list`, and documented in USAGE. Evidence: DESC-11 (filter by marker), DESC-12 (createAgent plumbs the field through).
- **Item 3 — Timezone docs:** replaced the one-line "Time zones" paragraph in `README.md` with a `### Timezones` subsection (17 lines) covering Linux `CRON_TZ`, macOS's lack of an equivalent, and two worked "9am Buenos Aires from UTC server" examples.
- **Item 4 — Cron sugar hints in errors:** `validateCronExpr` now wraps all throws and appends a `Tip: try one of these sugar forms via --at: ...` line listing hourly/daily/weekdays/weekly. `expandScheduleSugar` now includes the `Accepted forms: ...` string on every failure path (non-string, empty, unknown). Evidence: SCHED-14.
- **Item 5 — `launchctl bootstrap` → `load` fallback + cleanup:** `installLaunchd` now `unlink`s the plist when both `bootstrap` and `load` fail, so a complete-failure install leaves no half-installed artifact. Evidence: SCHED-15 (successful fallback path exercised via mocked `_execFn`), SCHED-16 (double-failure clears plist and throws a clear error).
- **Item 6 — Label prefix rename (`com.lupo.` → `com.agent-orchestrator.`):** updated in `orchestrator.mjs` (5 occurrences), `orchestrator.test.mjs` (2 assertions), `README.md` (1 table row), `~/.claude/skills/agent-orchestrator/SKILL.md`, and `~/.claude/skills/agent-orchestrator/references/commands.md`. The plan file is intentionally left unchanged as a historical record. Pre-check of `~/Library/LaunchAgents/com.agent-orchestrator.*` confirmed no stale plists on disk, so no user cleanup is needed.

To support SCHED-15/16 safely in CI (no pollution of `~/Library/LaunchAgents`), `_testSetDirs` gained an optional `launchAgents` key and `LAUNCH_AGENTS_DIR` became a mutable module-level binding (reset by `_testResetDirs`). `installLaunchd` is now exported alongside the other schedule primitives.
