# Self-Scheduling + NL Agent Generation

**Date:** 2026-04-24
**Scope:** Medium-large (~350 lines across orchestrator.mjs, scripts/, plans/, tests, README)
**Depends on:** The harness engineering work landed on 2026-04-23 (4 commits through `7a1620f`).

## Goal

Let the user say one sentence and get a fully wired, scheduled agent out the other end.

```
orchestrator describe "Expert bug fixer, runs on /projects/my-app once a day, fixes 1 bug per run, writes a report"
# → parses intent → creates agent → bootstraps domain knowledge via audit/improve → schedules via launchd/cron
```

And as a standalone primitive:

```
orchestrator schedule <name> --cron "0 9 * * 1-5"
orchestrator schedule <name> --remove
```

This turns the orchestrator into a self-bootstrapping system that can propose, build, tune, and install agents from natural language — using the LLM-meta primitives (`audit`, `improve`, `autoresearch`) that already exist.

## Out of scope (deliberately)

- Re-scheduling existing agents from the interval-based daemon config. If you want cron, use the new schedule command.
- Complex cron semantics (timezones, monotonic clocks, DST). Use naive local-time cron.
- Windows / WSL. macOS + Linux only.
- systemd-timer per agent — the existing `systemd/agent-orchestrator.service` keeps the daemon alive on my-linux-server; per-agent scheduling on that host goes through user-crontab.
- A web UI. CLI only.
- Auto-improve after deploy (autoresearch already exists; keep it separate).

## Design decisions made upfront

| Question | Decision | Why |
|---|---|---|
| Interactive vs auto? | Interactive by default, `--yes` skips confirmation | Matches your existing `--dangerously-skip-permissions`-aware style: opt-in automation |
| Platforms? | macOS → launchd, Linux → user crontab | Zero external deps, native on both your environments |
| Schedule storage? | Dual: `config.schedule.cron` in config.json AND OS-level artifact | `list` shows cron from config; install verifies the OS artifact exists |
| Mutual exclusivity with daemon interval? | Yes — cron and interval can't both be set. `schedule` errors if interval is set and vice versa | Prevents double-firing |
| Per-agent labeling? | macOS plist label `com.agent-orchestrator.<name>`; Linux crontab lines marked with `# agent-orchestrator:<name>` | Clean install/remove of a single agent without touching user's other launchd/cron entries |
| Cost cap for `describe`? | Default `--cost-budget 1.0` USD, `--max-iterations 2` on bootstrap loop | Keeps impulsive describe calls from racking up |

## Phase 1 — `schedule` command (foundation)

Standalone value: works on any existing agent, no dependency on `describe`.

### 1.1 CLI surface

```
orchestrator schedule <name> --cron "<expr>"     # install
orchestrator schedule <name> --at "daily 09:00"  # sugar → cron
orchestrator schedule <name> --at "hourly"       # sugar → "0 * * * *"
orchestrator schedule <name> --remove            # uninstall
orchestrator schedule <name>                     # show current
orchestrator schedule list                       # show all scheduled agents
```

### 1.2 Platform detection + install

- `process.platform === "darwin"` → launchd path
- `process.platform === "linux"` → crontab path
- Other → error with clear message

### 1.3 macOS launchd install

- Template a plist at `~/Library/LaunchAgents/com.agent-orchestrator.<name>.plist`
- `StartCalendarInterval` derived from cron expr (subset: minute/hour/day/weekday — skip day-of-month-in-month combos that launchd can't express)
- `ProgramArguments`: `[node, <absolute path to orchestrator.mjs>, run, <name>]`
- `WorkingDirectory`: the project root
- `StandardOutPath` / `StandardErrorPath`: agent's runs/ dir
- `plutil -lint` to validate before `launchctl load`
- `launchctl bootstrap gui/<uid> <plist>` (modern) with `bootout` for remove

### 1.4 Linux crontab install

- Read user's crontab via `crontab -l`
- Strip any existing line marked `# agent-orchestrator:<name>`
- Append new line: `<cron-expr> cd <project-root> && /usr/bin/node <abs-orchestrator-path> run <name> # agent-orchestrator:<name>`
- Pipe result back to `crontab -`
- Atomic: build new crontab in a tmp file, validate it parses, then install

### 1.5 Remove (both platforms)

- Reverse the install cleanly
- `--remove` is idempotent (no error if nothing installed)

### 1.6 Cron expr parser

Minimal — we only need to:
- Validate the expression is 5 fields
- Convert simple `"daily HH:MM"` / `"hourly"` / `"weekly"` sugar to real expressions
- Translate to launchd StartCalendarInterval keys (Minute/Hour/Day/Weekday)

No need to run a cron clock — the OS runs it.

### 1.7 Config persistence

Extend `config.schedule`:

```json
{
  "schedule": {
    "cron": "0 9 * * 1-5",
    "installedAt": "2026-04-24T12:00:00Z",
    "platform": "darwin"
  }
}
```

If `schedule.intervalSeconds` is set, `schedule --cron` errors out: "remove interval first or use --force".

## Phase 2 — `describe` command (NL → agent)

Builds on Phase 1.

### 2.1 CLI surface

```
orchestrator describe "<natural-language description>"
  --yes                   # skip interactive confirmation
  --dry-run               # print the parsed spec, create nothing
  --no-schedule           # create agent but don't schedule
  --no-bootstrap          # skip the audit+improve loop after creation
  --max-iterations <n>    # bootstrap iterations (default 2)
  --cost-budget <usd>     # total USD cap (default 1.0)
```

### 2.2 Intent parsing

Call Claude (haiku) with a meta-prompt that returns JSON:

```json
{
  "name": "daily-bug-fixer",
  "template": "developer",
  "mission": "Scan /projects/my-app for bugs...",
  "workdir": "/projects/my-app",
  "maxTurns": 25,
  "model": "sonnet",
  "schedule": {"cron": "0 9 * * *"},
  "outputFile": "report.md"
}
```

The meta-prompt template lives at `templates/meta/describe-prompt.md` (new).

### 2.3 Interactive confirm

Unless `--yes`:
- Print the parsed spec in a human-readable form
- Ask: `Create this agent? [y/N]`
- On n/empty: exit without creating
- On y: proceed

### 2.4 Create

Call existing `createAgent(spec)` with the parsed values. No changes to `createAgent` needed.

### 2.5 Bootstrap loop

Unless `--no-bootstrap`:
- Run `auditAgent(name)` once — capture the `domain_encoding` score
- If score < 6 AND budget allows AND iterations remaining:
  - Run `improveAgent(name, {apply: true})` — LLM proposes CLAUDE.md improvements, applies them
  - Re-audit, loop
- Cap at `--max-iterations` (default 2) or when score ≥ 6 or budget exhausted

This addresses the real audit finding: a fresh default-template agent scored 1/10 on domain_encoding. Bootstrap is what promotes the generic template into a domain-specialized harness.

### 2.6 Schedule

Unless `--no-schedule`:
- If the parsed spec contains `schedule.cron`, call the Phase 1 `schedule` command internally
- Otherwise ask: `When should this run? [one-shot / daily 09:00 / hourly / cron expression]`

### 2.7 Final report

Print:
```
Created agent "daily-bug-fixer"
  Mission:    Scan /projects/my-app for bugs and fix one per run
  Workdir:    /projects/my-app
  Schedule:   daily 09:00 (cron: 0 9 * * *)
  Bootstrap:  2 iterations, domain_encoding 1 → 6
  Cost:       $0.42 / $1.00 budget
  Run now:    node orchestrator.mjs run daily-bug-fixer
  View:       node orchestrator.mjs status daily-bug-fixer
```

## Phase 3 — Documentation + migration

### 3.1 README

Add a "Scheduling" section with examples for each platform. Add a "Describe" section showing the one-liner workflow.

### 3.2 Existing agents

No migration needed — existing agents keep their `config.schedule.intervalSeconds` and the daemon loop keeps handling them as before. New `describe`-generated agents use the cron path. Both coexist.

### 3.3 Public release

Update `.release-exclude` if needed — the new commands are generic, should flow to the public repo cleanly.

## Tests

### Unit tests (orchestrator.test.mjs)
- cron expression validation (valid / invalid / sugar expansion)
- launchd plist generation (snapshot test against a known-good plist)
- crontab line generation + removal (idempotent round-trip)
- describe-spec parsing (mock the Claude call, verify config mapping)
- bootstrap loop termination conditions (budget exhaustion, score threshold, iteration cap)

### Integration tests
- Phase 1 install → verify plist exists + `launchctl list` includes the label (macOS only, skip on Linux CI)
- Phase 1 remove → verify plist gone + `launchctl list` doesn't include it
- Phase 2 describe with mocked Claude → verify agent dir created and schedule installed

### Manual smoke test (required before merge)
- `orchestrator describe "Dummy test agent that does nothing, runs hourly"`
- Confirm spec, create, verify scheduled, check `launchctl list | grep agent-orchestrator`
- `orchestrator schedule dummy-test --remove`
- Verify plist gone

## Risk register

| Risk | Mitigation |
|---|---|
| LLM mis-parses the description → wrong agent installed | Interactive confirm by default. `--dry-run` for automation. Can always `delete` + `describe` again. |
| Our plist generator has a bug → corrupts user's launchd state | `plutil -lint` validation before `launchctl load`. Write to tmp file then atomically move. |
| User's crontab has hand-edited entries we don't understand | Never rewrite lines we didn't create — only add/remove lines matching `# agent-orchestrator:<name>` marker. |
| Bootstrap loop runs away cost-wise | Hard cap on iterations (2 default) + hard cap on USD budget ($1.0 default). Both enforceable in the existing cost tracker. |
| Timezone confusion | Accept it as a known limitation; use local time. Document this. |
| Running `describe` from the wrong cwd silently uses a bad project path | `describe` uses absolute paths resolved from `import.meta.url`, not cwd. |
| Double-scheduling (daemon interval + cron) | Phase 1 explicitly errors if both are set without `--force`. |

## Success criteria

After all phases:
1. `orchestrator schedule <existing-agent> --cron "..."` installs a launchd plist on macOS / crontab line on Linux that fires `node orchestrator.mjs run <name>` on schedule.
2. `orchestrator schedule <name> --remove` is a clean uninstall.
3. `orchestrator describe "..."` produces a sensible spec, asks for confirmation, creates the agent, runs a bootstrap audit/improve loop, and schedules it — all from one command, one description.
4. An agent created via `describe` scores ≥ 6 on `domain_encoding` after bootstrap (or at least measurably higher than the 1/10 baseline we captured).
5. All existing tests pass. New unit tests for cron parser, plist generator, crontab edits.
6. Manual smoke test documented in a brief `plans/2026-04-24-*-REPORT.md`.

---

## Implementation Team

Three specialist agents in sequence (later phases depend on earlier ones), plus a reviewer.

### Wave 1 — `schedule` command
**Agent A: `scheduler-builder`** (model: sonnet)
- Scope: Phase 1 only
- Reads: this plan, `orchestrator.mjs` CLI dispatch code, systemd/*.service for reference
- Creates:
  - New CLI subcommand branches in orchestrator.mjs
  - Platform detection + install/remove logic (~180 lines in a new section of orchestrator.mjs)
  - Cron → launchd StartCalendarInterval converter
  - Crontab line read/edit/write helpers
  - Unit tests for each pure function
- Verification: all new unit tests pass, manual smoke on macOS (install + remove a schedule on a throwaway agent, inspect plist, `launchctl list`, remove)
- Commit message: `feat(schedule): add schedule/unschedule commands for cron-based runs`

### Wave 2 — `describe` command
**Agent B: `describe-builder`** (model: sonnet)
- Scope: Phase 2 only; depends on Wave 1 landed
- Reads: this plan, Wave 1 output, existing `auditAgent`/`improveAgent`/`createAgent` in orchestrator.mjs
- Creates:
  - `templates/meta/describe-prompt.md` — the NL→spec meta-prompt
  - New CLI subcommand branches in orchestrator.mjs for `describe`
  - Interactive confirm prompt (readline-based, zero-dep)
  - Bootstrap loop that calls existing audit/improve
  - Cost-budget guard
  - Unit tests with mocked Claude call
- Verification: unit tests green, manual smoke (real Claude call) — describe a dummy agent, confirm, create, bootstrap, schedule, verify, remove
- Commit message: `feat(describe): natural-language agent generation with bootstrap + auto-schedule`

### Wave 3 — Review + docs
**Agent C: `docs-and-review`** (model: sonnet)
- Scope: Phase 3 + verification
- Reads: everything from waves 1 and 2
- Does:
  1. Runs full test suite, all hook tests — must stay green
  2. Updates README with `Scheduling` and `Describe` sections, examples per platform
  3. Creates `plans/2026-04-24-self-scheduling-and-describe-REPORT.md` with smoke test results
  4. Flags any API surface inconsistencies between new and existing commands
  5. Checks `.release-exclude` — are the new commands safe for public release? (they should be, but verify)
- Does NOT edit code — review-only
- Commit message: `docs: add scheduling + describe to README; verification report`

### Dispatch instructions

```
1. Read this plan.
2. Spawn Wave 1 (scheduler-builder). Block until green. Review diff. Commit.
3. Spawn Wave 2 (describe-builder). Block until green. Review diff. Commit.
4. Spawn Wave 3 (docs-and-review). Read report. Commit.
5. Push.
```

Waves are serialized because Wave 2 imports from Wave 1's new helpers.

### Cost estimate
- Agent A: ~$0.60 (writes ~200 lines, runs tests)
- Agent B: ~$0.80 (writes ~150 lines + does real Claude smoke test)
- Agent C: ~$0.40 (review + README)
- **Total: ~$2** from a fresh session.

Plus during `describe` development Agent B will spend real budget on at least one real smoke test (~$0.50).
