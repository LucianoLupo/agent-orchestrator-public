import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { recoverStaleAgents, buildFreshPrompt, buildResumePrompt, computeBackoffMs, classifyFailure, updateCostAccumulators, applyAuditImprovements, buildChangelogEntry, topoSort, loadPipeline, writeAtomicJson, initRunState, recoverStalePipelineRuns, buildPipelineWorkerPrompt, parseGateDecision, buildGatePrompt, readAgentConfig, _testSetSpawnClaude, _testResetSpawnClaude, _testSetDirs, _testResetDirs, _testSetExec, _testResetExec, runPipelineStage, createAgent, createMutex, computeClaudeMdHash, revertClaudeMd, writeExperimentLog, autoresearchAgent, generateVariantSubsets, cloneAgent, cleanupVariants, competeAgent, evolveAgent, expandScheduleSugar, validateCronExpr, cronToLaunchdInterval, cronToLaunchdPlist, buildCrontabLine, stripCrontabForAgent, extractJsonObject, validateDescribeSpec, parseDescription, bootstrapAgent, describeAgent, describeList, installLaunchd, _testSetPromptConfirm, _testResetPromptConfirm } from "./orchestrator.mjs";
import { tmpdir } from "node:os";
import { readFile, rm as rmFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "orchestrator.mjs"), "utf8");

// CRASH-01: dead PID resets to error
test("CRASH-01: dead PID is reset to error", async () => {
  const mockWrite = async () => {};
  const futureExpiry = new Date(Date.now() + 60_000).toISOString();
  const agents = [
    {
      name: "test-agent",
      state: {
        status: "running",
        runningPid: 99999999, // dead PID
        lockExpiry: futureExpiry,
        lastError: null,
      },
    },
  ];

  await recoverStaleAgents(agents, mockWrite);

  assert.equal(agents[0].state.status, "error");
  assert.equal(agents[0].state.lastError, "stale_lock_recovered");
  assert.equal(agents[0].state.runningPid, null);
  assert.equal(agents[0].state.lockExpiry, null);
});

// CRASH-01: null PID resets to error
test("CRASH-01: null PID resets to error", async () => {
  const mockWrite = async () => {};
  const agents = [
    {
      name: "test-agent",
      state: {
        status: "running",
        runningPid: null,
        lockExpiry: null,
        lastError: null,
      },
    },
  ];

  await recoverStaleAgents(agents, mockWrite);

  assert.equal(agents[0].state.status, "error");
  assert.equal(agents[0].state.lastError, "stale_lock_recovered");
  assert.equal(agents[0].state.runningPid, null);
  assert.equal(agents[0].state.lockExpiry, null);
});

// CRASH-01: alive PID with future expiry is not reset
test("CRASH-01: alive PID with future lockExpiry is not reset", async () => {
  const mockWrite = async () => {};
  const futureExpiry = new Date(Date.now() + 60_000).toISOString();
  const agents = [
    {
      name: "test-agent",
      state: {
        status: "running",
        runningPid: process.pid, // this process is alive
        lockExpiry: futureExpiry,
        lastError: null,
      },
    },
  ];

  await recoverStaleAgents(agents, mockWrite);

  // Should NOT be reset — PID is alive and lock hasn't expired
  assert.equal(agents[0].state.status, "running");
  assert.equal(agents[0].state.lastError, null);
});

// CRASH-01: expired lock resets even if PID is alive
test("CRASH-01: expired lockExpiry resets even with alive PID", async () => {
  const mockWrite = async () => {};
  const pastExpiry = new Date(Date.now() - 60_000).toISOString(); // expired
  const agents = [
    {
      name: "test-agent",
      state: {
        status: "running",
        runningPid: process.pid, // alive PID, but lock expired
        lockExpiry: pastExpiry,
        lastError: null,
      },
    },
  ];

  await recoverStaleAgents(agents, mockWrite);

  assert.equal(agents[0].state.status, "error");
  assert.equal(agents[0].state.lastError, "stale_lock_recovered");
  assert.equal(agents[0].state.runningPid, null);
  assert.equal(agents[0].state.lockExpiry, null);
});

// CRASH-03: recovery logs reason
test("CRASH-03: recovery logs stale_lock_recovered", async () => {
  const logs = [];
  const mockWrite = async () => {};

  // Capture console.log output
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    const agents = [
      {
        name: "my-agent",
        state: {
          status: "running",
          runningPid: null,
          lockExpiry: null,
          lastError: null,
        },
      },
    ];

    await recoverStaleAgents(agents, mockWrite);
  } finally {
    console.log = originalLog;
  }

  const logOutput = logs.join("\n");
  assert.ok(
    logOutput.includes("stale_lock_recovered"),
    `Expected log to contain "stale_lock_recovered", got: ${logOutput}`,
  );
  assert.ok(
    logOutput.includes("my-agent"),
    `Expected log to contain agent name "my-agent", got: ${logOutput}`,
  );
});

// CRASH-02 / PROMPT-01: fresh prompt contains turn count and no undefined
test("CRASH-02: buildFreshPrompt returns string without undefined", () => {
  const config = { name: "test", maxTurns: 25, workdir: null };
  const result = buildFreshPrompt(config, "/tmp/agentdir", "/tmp/rundir", null);

  assert.ok(typeof result === "string", "should return a string");
  assert.ok(!result.includes("undefined"), `should not contain 'undefined', got: ${result}`);
  assert.ok(result.includes("25"), "should include turn count");
  assert.ok(result.includes("/tmp/rundir"), "should include runDir");
});

// buildResumePrompt: contains runDir and turn count
test("CRASH-02: buildResumePrompt returns string without undefined", () => {
  const config = { maxTurns: 25 };
  const result = buildResumePrompt(config, "/tmp/rundir", "session-abc");

  assert.ok(typeof result === "string", "should return a string");
  assert.ok(!result.includes("undefined"), `should not contain 'undefined', got: ${result}`);
  assert.ok(result.includes("25"), "should include turn count");
  assert.ok(result.includes("/tmp/rundir"), "should include runDir");
});

// DAEMON-01: concurrency cap uses continue not break
test("DAEMON-01: concurrency cap uses continue not break", () => {
  assert.ok(
    src.includes("if (active.size >= maxConcurrent) continue;"),
    "Expected 'continue' not 'break' for concurrency cap",
  );
  assert.ok(
    !src.includes("if (active.size >= maxConcurrent) break;"),
    "Must not have break on concurrency cap",
  );
});

// PROMPT-01: fresh prompt includes turn count
test("PROMPT-01: fresh prompt includes turn count", () => {
  const config = { name: "test-agent", maxTurns: 15, workdir: null };
  const prompt = buildFreshPrompt(config, "/agents/test", "/agents/test/runs/t1", null);
  assert.ok(prompt.includes("15 turns total"), `Missing turn count. Got: ${prompt}`);
});

// PROMPT-02: fresh prompt includes output directory instruction
test("PROMPT-02: fresh prompt includes output directory instruction", () => {
  const config = { name: "test-agent", maxTurns: 15, workdir: null };
  const prompt = buildFreshPrompt(config, "/agents/test", "/agents/test/runs/t1", null);
  assert.ok(
    prompt.includes("Write your key outputs to /agents/test/runs/t1/ before stopping"),
    `Missing output instruction. Got: ${prompt}`,
  );
});

// PROMPT-03: resume prompt includes runDir
test("PROMPT-03: resume prompt includes runDir", () => {
  const config = { maxTurns: 15 };
  const prompt = buildResumePrompt(config, "/agents/test/runs/t1", null);
  assert.ok(
    prompt.includes("Save run outputs to: /agents/test/runs/t1/"),
    `Missing runDir. Got: ${prompt}`,
  );
});

// PROMPT-04: resume prompt includes turn count reminder
test("PROMPT-04: resume prompt includes turn count reminder", () => {
  const config = { maxTurns: 15 };
  const prompt = buildResumePrompt(config, "/agents/test/runs/t1", null);
  assert.ok(prompt.includes("15 turns total"), `Missing turn count. Got: ${prompt}`);
});

// PROMPT-04 edge: resume prompt with custom message still includes turn count
test("PROMPT-04: resume prompt with custom message still includes turn count", () => {
  const config = { maxTurns: 20 };
  const prompt = buildResumePrompt(config, "/agents/test/runs/t2", "Do the task");
  assert.ok(prompt.includes("20 turns total"), `Missing turn count. Got: ${prompt}`);
  assert.ok(prompt.includes("Do the task"), "Missing custom message");
});

// DAEMON-02: computeBackoffMs — exponential backoff math
test("DAEMON-02: computeBackoffMs(0) returns 0 (no backoff for zero errors)", () => {
  assert.equal(computeBackoffMs(0), 0);
});

test("DAEMON-02: computeBackoffMs(1) returns 5000 (5s)", () => {
  assert.equal(computeBackoffMs(1), 5000);
});

test("DAEMON-02: computeBackoffMs(2) returns 10000 (10s)", () => {
  assert.equal(computeBackoffMs(2), 10000);
});

test("DAEMON-02: computeBackoffMs(3) returns 20000 (20s)", () => {
  assert.equal(computeBackoffMs(3), 20000);
});

test("DAEMON-02: computeBackoffMs(10) returns 300000 (capped at 5 min)", () => {
  assert.equal(computeBackoffMs(10), 300000);
});

// DAEMON-04: classifyFailure — auth errors
test("DAEMON-04: classifyFailure with 401 in stderr returns auth_error", () => {
  assert.equal(classifyFailure("401 unauthorized", ""), "auth_error");
});

test("DAEMON-04: classifyFailure with invalid api key in stdout returns auth_error", () => {
  assert.equal(classifyFailure("", "invalid api key"), "auth_error");
});

test("DAEMON-04: classifyFailure with authentication failed in stderr returns auth_error", () => {
  assert.equal(classifyFailure("authentication failed", ""), "auth_error");
});

// DAEMON-05: classifyFailure — transient errors
test("DAEMON-05: classifyFailure with 429 rate limit returns transient", () => {
  assert.equal(classifyFailure("429 rate limit exceeded", ""), "transient");
});

test("DAEMON-05: classifyFailure with overloaded in stdout returns transient", () => {
  assert.equal(classifyFailure("", "overloaded"), "transient");
});

test("DAEMON-05: classifyFailure with 503 service unavailable returns transient", () => {
  assert.equal(classifyFailure("503 service unavailable", ""), "transient");
});

test("DAEMON-05: classifyFailure with unknown crash returns transient (default)", () => {
  assert.equal(classifyFailure("unknown crash", ""), "transient");
});

// DAEMON-03: classifyFailure distinguishes auth_error from transient (source-level check)
test("DAEMON-03: classifyFailure returns auth_error not transient for 401", () => {
  const result = classifyFailure("401 unauthorized", "");
  assert.notEqual(result, "transient", "401 error should not be transient");
  assert.equal(result, "auth_error");
});

// COST-01: updateCostAccumulators — same-day accumulation
test("COST-01: accumulates costUsd to dailyCost.totalUsd on same day", () => {
  const today = new Date().toLocaleDateString("en-CA");
  const state = { dailyCost: { date: today, totalUsd: 0.50 }, lifetimeCostUsd: 0.0 };
  updateCostAccumulators(state, 0.25);
  assert.ok(Math.abs(state.dailyCost.totalUsd - 0.75) < 1e-9, `Expected 0.75, got ${state.dailyCost.totalUsd}`);
  assert.equal(state.dailyCost.date, today);
});

// COST-01: updateCostAccumulators — resets dailyCost when date differs from today
test("COST-01: resets dailyCost when stored date is in the past", () => {
  const today = new Date().toLocaleDateString("en-CA");
  const state = { dailyCost: { date: "2020-01-01", totalUsd: 5.0 }, lifetimeCostUsd: 10.0 };
  updateCostAccumulators(state, 0.10);
  assert.equal(state.dailyCost.date, today, "date should be today after reset");
  assert.ok(Math.abs(state.dailyCost.totalUsd - 0.10) < 1e-9, `Expected 0.10 (reset then add), got ${state.dailyCost.totalUsd}`);
});

// COST-01: updateCostAccumulators — creates dailyCost from scratch if missing
test("COST-01: creates dailyCost from scratch if state.dailyCost is missing", () => {
  const today = new Date().toLocaleDateString("en-CA");
  const state = { lifetimeCostUsd: 0.0 };
  updateCostAccumulators(state, 0.30);
  assert.ok(state.dailyCost != null, "dailyCost should be created");
  assert.equal(state.dailyCost.date, today);
  assert.ok(Math.abs(state.dailyCost.totalUsd - 0.30) < 1e-9, `Expected 0.30, got ${state.dailyCost.totalUsd}`);
});

// COST-02: updateCostAccumulators — increments lifetimeCostUsd
test("COST-02: increments state.lifetimeCostUsd", () => {
  const today = new Date().toLocaleDateString("en-CA");
  const state = { dailyCost: { date: today, totalUsd: 0.0 }, lifetimeCostUsd: 1.0 };
  updateCostAccumulators(state, 0.10);
  assert.ok(Math.abs(state.lifetimeCostUsd - 1.10) < 1e-9, `Expected 1.10, got ${state.lifetimeCostUsd}`);
});

// COST-01/02: null costUsd is ignored — no accumulation, no error
test("COST-01/02: null costUsd is ignored — no accumulation", () => {
  const today = new Date().toLocaleDateString("en-CA");
  const state = { dailyCost: { date: today, totalUsd: 0.50 }, lifetimeCostUsd: 1.0 };
  updateCostAccumulators(state, null);
  assert.equal(state.dailyCost.totalUsd, 0.50, "dailyCost should not change on null");
  assert.equal(state.lifetimeCostUsd, 1.0, "lifetimeCostUsd should not change on null");
});

// COST-01/02: costUsd of 0.0 IS accumulated (valid free run)
test("COST-01/02: costUsd of 0.0 is accumulated as a valid free run", () => {
  const today = new Date().toLocaleDateString("en-CA");
  const state = { dailyCost: { date: today, totalUsd: 0.50 }, lifetimeCostUsd: 1.0 };
  updateCostAccumulators(state, 0.0);
  assert.ok(Math.abs(state.dailyCost.totalUsd - 0.50) < 1e-9, "0.0 should not change totalUsd");
  assert.ok(Math.abs(state.lifetimeCostUsd - 1.0) < 1e-9, "0.0 should not change lifetime when added to 1.0");
});

// COST-01/02: creates lifetimeCostUsd from 0 if missing
test("COST-02: creates lifetimeCostUsd from scratch if missing", () => {
  const today = new Date().toLocaleDateString("en-CA");
  const state = { dailyCost: { date: today, totalUsd: 0.0 } };
  updateCostAccumulators(state, 0.05);
  assert.ok(Math.abs(state.lifetimeCostUsd - 0.05) < 1e-9, `Expected 0.05, got ${state.lifetimeCostUsd}`);
});

// HOOK-01: spawnClaude env merge pattern
test("HOOK-01: spawnClaude merges env with process.env when env provided", () => {
  assert.ok(
    src.includes("env: env ? { ...process.env, ...env } : undefined"),
    "spawnClaude must merge env with process.env when env is provided"
  );
});

// HOOK-01: spawnClaude signature includes env param
test("HOOK-01: spawnClaude signature accepts env parameter", () => {
  assert.ok(
    src.includes("{ cwd, timeout = AGENT_TIMEOUT, onPid, env }"),
    "spawnClaude destructuring must include env parameter"
  );
});

// HOOK-02: file gate check in hook
const hookSrc = readFileSync(join(__dirname, "shared/hooks/stop-completion-check.sh"), "utf8");

test("HOOK-02: stop hook checks AGENT_OUTPUT_FILE existence", () => {
  assert.ok(
    hookSrc.includes("AGENT_OUTPUT_FILE"),
    "stop-completion-check.sh must reference AGENT_OUTPUT_FILE"
  );
  assert.ok(
    hookSrc.includes("! -f"),
    "stop hook must check file existence with [ ! -f ]"
  );
});

// HOOK-03: semantic completion check moved from regex heuristic to prompt hook in settings.json
// (see plans/2026-04-23-harness-engineering-fixes.md Phase 2.3)
test("HOOK-03: stop hook delegates semantic check to settings.json prompt hook", () => {
  // The shell hook must NOT contain the old brittle regex heuristics
  assert.ok(
    !/grep\s+-qiE.*implement/.test(hookSrc),
    "old 'grep -qiE ... implement' regex must be removed"
  );
  assert.ok(
    !/grep\s+-qE.*TODO/.test(hookSrc),
    "old TODO/FIXME grep heuristic must be removed"
  );
  // The deterministic gate (AGENT_OUTPUT_FILE) must remain
  assert.ok(hookSrc.includes("AGENT_OUTPUT_FILE"), "deterministic output-file gate must remain");

  // The semantic check must now live in shared/settings.json as a Stop prompt hook
  const settingsSrc = readFileSync(join(__dirname, "shared/settings.json"), "utf8");
  const settings = JSON.parse(settingsSrc);
  const stopHooks = (settings.hooks?.Stop ?? []).flatMap((entry) => entry.hooks ?? []);
  const promptHook = stopHooks.find((h) => h.type === "prompt");
  assert.ok(promptHook, "Stop hooks must include a prompt-type entry for semantic completion");
  assert.equal(promptHook.model, "haiku", "semantic stop hook should use haiku");
});

// HOOK-04: template defaulting
test("HOOK-04: createAgent defaults outputFile to report.md for researcher/judge templates", () => {
  assert.ok(
    src.includes('"report.md"') && src.includes("researcher"),
    "createAgent must default outputFile to report.md for researcher template"
  );
});

// COST-03: budget circuit breaker is wired after updateCostAccumulators call in runAgent
test("COST-03: runAgent wires budget_exceeded check after updateCostAccumulators", () => {
  // Source-level assertion: verify the circuit breaker pattern exists after updateCostAccumulators call
  assert.ok(
    src.includes("updateCostAccumulators(state, parsed.costUsd)"),
    "Expected updateCostAccumulators call with parsed.costUsd in runAgent",
  );
  assert.ok(
    src.includes("budget_exceeded"),
    "Expected budget_exceeded status to be set in runAgent",
  );
  const updateIdx = src.indexOf("updateCostAccumulators(state, parsed.costUsd)");
  const budgetIdx = src.indexOf('"budget_exceeded"');
  assert.ok(
    budgetIdx > updateIdx,
    "budget_exceeded check should appear after updateCostAccumulators call",
  );
});

// COST-05: startDaemon resets budget_exceeded agents on new calendar day
test("COST-05: startDaemon has budget_exceeded midnight reset logic", () => {
  // Source-level assertion: verify the reset pattern exists in startDaemon
  assert.ok(
    src.includes('status === "budget_exceeded"'),
    "Expected budget_exceeded check in startDaemon",
  );
  assert.ok(
    src.includes("budget reset for new day"),
    "Expected midnight reset log message in startDaemon",
  );
  assert.ok(
    src.includes("agent.state.status = \"idle\""),
    "Expected status reset to idle on new day",
  );
});

// META-01: applyAuditImprovements finds text that exists in CLAUDE.md
test("META-01: applyAuditImprovements finds text that exists in CLAUDE.md", () => {
  const claudeMd = "# Identity\n\nTurn budget: Orient (1-2), Plan (2).\n\nMore content.";
  const improvements = [
    { section: "Turn budget", current: "Turn budget: Orient (1-2), Plan (2).", suggested: "Turn budget: Orient (1-2), Plan (1-2).", reason: "Clarify plan turns" }
  ];
  const results = applyAuditImprovements(claudeMd, improvements);
  assert.equal(results.length, 1);
  assert.equal(results[0].found, true);
  assert.equal(results[0].section, "Turn budget");
});

// META-05: applyAuditImprovements marks not-found when text absent
test("META-05: applyAuditImprovements marks not-found when text absent", () => {
  const claudeMd = "# Identity\n\nSome other content entirely.";
  const improvements = [
    { section: "Turn budget", current: "Turn budget: Orient (1-2), Plan (2).", suggested: "Turn budget: Orient (1-2), Plan (1-2).", reason: "reason" }
  ];
  const results = applyAuditImprovements(claudeMd, improvements);
  assert.equal(results[0].found, false);
});

// META-03: applyAuditImprovements does not mutate input string (dry-run purity)
test("META-03: applyAuditImprovements does not mutate input string", () => {
  const original = "# Identity\n\nTurn budget: Orient (1-2), Plan (2).";
  const improvements = [
    { section: "s", current: "Turn budget: Orient (1-2), Plan (2).", suggested: "NEW TEXT", reason: "r" }
  ];
  applyAuditImprovements(original, improvements);
  // Input string unchanged — pure function
  assert.equal(original, "# Identity\n\nTurn budget: Orient (1-2), Plan (2).");
});

// META-04: buildChangelogEntry produces correct markdown format
test("META-04: buildChangelogEntry produces correct markdown format", () => {
  const date = "2026-03-20T19:00:00.000Z";
  const sections = ["Turn budget", "Memory protocol"];
  const result = buildChangelogEntry(sections, date);
  assert.ok(result.includes("## Improve History"), "must include heading");
  assert.ok(result.includes("2026-03-20T19:00:00.000Z"), "must include date");
  assert.ok(result.includes("- Turn budget"), "must list applied sections");
  assert.ok(result.includes("- Memory protocol"), "must list all sections");
});

// META-02: improveAgent archives to .claude/memory/ with timestamp
test("META-02: improveAgent archives to .claude/memory/ with timestamp", () => {
  assert.ok(
    src.includes(".claude") && src.includes("memory") && src.includes("CLAUDE.md.bak-"),
    "improveAgent must archive to .claude/memory/ with timestamped filename"
  );
});

// --- PIPE-03: topoSort ---

// topoSort: linear chain A->B->C returns [A, B, C]
test("PIPE-03: topoSort linear chain A->B->C returns correct order", () => {
  const stages = [
    { name: "A", depends_on: [] },
    { name: "B", depends_on: ["A"] },
    { name: "C", depends_on: ["B"] },
  ];
  const { order } = topoSort(stages);
  assert.deepEqual(order.map(s => s.name), ["A", "B", "C"]);
});

// topoSort: diamond [A->C, B->C] returns A and B before C
test("PIPE-03: topoSort diamond — A and B before C", () => {
  const stages = [
    { name: "A", depends_on: [] },
    { name: "B", depends_on: [] },
    { name: "C", depends_on: ["A", "B"] },
  ];
  const { order } = topoSort(stages);
  const names = order.map(s => s.name);
  assert.ok(names.indexOf("A") < names.indexOf("C"), "A must come before C");
  assert.ok(names.indexOf("B") < names.indexOf("C"), "B must come before C");
  assert.equal(names.length, 3);
});

// topoSort: independent stages [A, B] returns both
test("PIPE-03: topoSort independent stages returns both", () => {
  const stages = [
    { name: "A", depends_on: [] },
    { name: "B", depends_on: [] },
  ];
  const { order } = topoSort(stages);
  assert.equal(order.length, 2);
  const names = order.map(s => s.name);
  assert.ok(names.includes("A"));
  assert.ok(names.includes("B"));
});

// topoSort: self-reference throws with stage name
test("PIPE-03: topoSort self-reference throws mentioning stage name", () => {
  const stages = [
    { name: "loop", depends_on: ["loop"] },
  ];
  assert.throws(
    () => topoSort(stages),
    (err) => err.message.includes("loop"),
    "should throw with stage name in message"
  );
});

// topoSort: circular dependency (A->B->A) throws mentioning involved stages
test("PIPE-03: topoSort circular dependency throws mentioning involved stages", () => {
  const stages = [
    { name: "A", depends_on: ["B"] },
    { name: "B", depends_on: ["A"] },
  ];
  assert.throws(
    () => topoSort(stages),
    (err) => err.message.includes("A") || err.message.includes("B"),
    "should throw mentioning involved stages"
  );
});

// topoSort: reference to non-existent stage throws with clear message
test("PIPE-03: topoSort unknown dep reference throws with clear message", () => {
  const stages = [
    { name: "A", depends_on: ["nonexistent"] },
  ];
  assert.throws(
    () => topoSort(stages),
    (err) => err.message.includes("nonexistent"),
    "should throw mentioning the unknown stage name"
  );
});

// --- PIPE-01, PIPE-02: loadPipeline ---

// loadPipeline: version != 1 throws "unknown version"
test("PIPE-01: loadPipeline rejects unknown version", async () => {
  // Use a mock by patching a temp pipeline dir
  const tmpDir = join(__dirname, "pipelines", "_test-version");
  await mkdir(tmpDir, { recursive: true });
  await writeFile(join(tmpDir, "pipeline.json"), JSON.stringify({
    name: "_test-version",
    version: 2,
    stages: [],
  }));
  try {
    await assert.rejects(
      () => loadPipeline("_test-version"),
      (err) => err.message.toLowerCase().includes("version"),
      "should throw mentioning version"
    );
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

// loadPipeline: valid config with version 1 returns parsed object with sorted stages
test("PIPE-01: loadPipeline valid version 1 returns sorted stages", async () => {
  const tmpDir = join(__dirname, "pipelines", "_test-valid");
  const agentDir = join(__dirname, "agents", "_test-agent-valid");
  await mkdir(tmpDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(tmpDir, "pipeline.json"), JSON.stringify({
    name: "_test-valid",
    version: 1,
    stages: [
      { name: "stage-a", agent: "_test-agent-valid", depends_on: [], max_retries: 1 },
    ],
  }));
  try {
    const result = await loadPipeline("_test-valid");
    assert.equal(result.name, "_test-valid");
    assert.equal(result.version, 1);
    assert.ok(Array.isArray(result.stages));
    assert.equal(result.stages.length, 1);
    assert.equal(result.stages[0].name, "stage-a");
  } finally {
    await rm(tmpDir, { recursive: true });
    await rm(agentDir, { recursive: true });
  }
});

// loadPipeline: missing agent directory throws mentioning agent name
test("PIPE-02: loadPipeline missing agent throws mentioning agent name", async () => {
  const tmpDir = join(__dirname, "pipelines", "_test-missing-agent");
  await mkdir(tmpDir, { recursive: true });
  await writeFile(join(tmpDir, "pipeline.json"), JSON.stringify({
    name: "_test-missing-agent",
    version: 1,
    stages: [
      { name: "stage-a", agent: "_nonexistent-agent-xyz", depends_on: [], max_retries: 1 },
    ],
  }));
  try {
    await assert.rejects(
      () => loadPipeline("_test-missing-agent"),
      (err) => err.message.includes("_nonexistent-agent-xyz"),
      "should throw mentioning agent name"
    );
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

// loadPipeline: duplicate stage names throws
test("PIPE-01: loadPipeline duplicate stage names throws", async () => {
  const tmpDir = join(__dirname, "pipelines", "_test-dup-stages");
  const agentDir = join(__dirname, "agents", "_test-agent-dup");
  await mkdir(tmpDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(tmpDir, "pipeline.json"), JSON.stringify({
    name: "_test-dup-stages",
    version: 1,
    stages: [
      { name: "stage-a", agent: "_test-agent-dup", depends_on: [], max_retries: 1 },
      { name: "stage-a", agent: "_test-agent-dup", depends_on: [], max_retries: 1 },
    ],
  }));
  try {
    await assert.rejects(
      () => loadPipeline("_test-dup-stages"),
      (err) => err.message.toLowerCase().includes("duplicate") || err.message.includes("stage-a"),
      "should throw on duplicate stage names"
    );
  } finally {
    await rm(tmpDir, { recursive: true });
    await rm(agentDir, { recursive: true });
  }
});

// loadPipeline: $prev in prompt with depends_on.length > 1 throws
test("DATA-01: loadPipeline $prev with multiple depends_on throws", async () => {
  const tmpDir = join(__dirname, "pipelines", "_test-prev-multi");
  const agentDir = join(__dirname, "agents", "_test-agent-prev");
  await mkdir(tmpDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(tmpDir, "pipeline.json"), JSON.stringify({
    name: "_test-prev-multi",
    version: 1,
    stages: [
      { name: "a", agent: "_test-agent-prev", depends_on: [], max_retries: 1 },
      { name: "b", agent: "_test-agent-prev", depends_on: [], max_retries: 1 },
      { name: "c", agent: "_test-agent-prev", prompt: "Use $prev output", depends_on: ["a", "b"], max_retries: 1 },
    ],
  }));
  try {
    await assert.rejects(
      () => loadPipeline("_test-prev-multi"),
      (err) => err.message.includes("$prev"),
      "should throw when $prev used with multiple depends_on"
    );
  } finally {
    await rm(tmpDir, { recursive: true });
    await rm(agentDir, { recursive: true });
  }
});

// loadPipeline: $prev in prompt with depends_on.length == 1 passes
test("DATA-01: loadPipeline $prev with single depends_on passes", async () => {
  const tmpDir = join(__dirname, "pipelines", "_test-prev-single");
  const agentDir = join(__dirname, "agents", "_test-agent-prev-s");
  await mkdir(tmpDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(tmpDir, "pipeline.json"), JSON.stringify({
    name: "_test-prev-single",
    version: 1,
    stages: [
      { name: "a", agent: "_test-agent-prev-s", depends_on: [], max_retries: 1 },
      { name: "b", agent: "_test-agent-prev-s", prompt: "Use $prev output", depends_on: ["a"], max_retries: 1 },
    ],
  }));
  try {
    const result = await loadPipeline("_test-prev-single");
    assert.ok(result.stages.length === 2);
  } finally {
    await rm(tmpDir, { recursive: true });
    await rm(agentDir, { recursive: true });
  }
});

// loadPipeline: $prev in prompt with depends_on.length == 0 throws
test("DATA-01: loadPipeline $prev with no depends_on throws (no predecessor)", async () => {
  const tmpDir = join(__dirname, "pipelines", "_test-prev-empty");
  const agentDir = join(__dirname, "agents", "_test-agent-prev-e");
  await mkdir(tmpDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(tmpDir, "pipeline.json"), JSON.stringify({
    name: "_test-prev-empty",
    version: 1,
    stages: [
      { name: "a", agent: "_test-agent-prev-e", prompt: "Use $prev output", depends_on: [], max_retries: 1 },
    ],
  }));
  try {
    await assert.rejects(
      () => loadPipeline("_test-prev-empty"),
      (err) => err.message.includes("$prev"),
      "should throw when $prev used with empty depends_on"
    );
  } finally {
    await rm(tmpDir, { recursive: true });
    await rm(agentDir, { recursive: true });
  }
});

// PIPE-04: pipeline validate CLI exits non-zero on error (source assertion)
test("PIPE-04: validatePipeline exits non-zero on error (source-level check)", () => {
  assert.ok(
    src.includes("process.exit(1)") && src.includes("ERROR:"),
    "validatePipeline must call process.exit(1) and print ERROR: on failure"
  );
});

// PIPE-04: pipeline case exists in main() switch (source assertion)
test("PIPE-04: pipeline case exists in main() switch", () => {
  assert.ok(
    src.includes('case "pipeline"'),
    "main() switch must have a pipeline case"
  );
});

// --- EXEC-03: writeAtomicJson ---

// EXEC-03: writeAtomicJson writes valid JSON with 2-space indent and trailing newline
test("EXEC-03: writeAtomicJson writes valid JSON with 2-space indent and trailing newline", async () => {
  const dir = await (async () => {
    const d = join(tmpdir(), `test-atomic-${Date.now()}`);
    await mkdir(d, { recursive: true });
    return d;
  })();
  try {
    const filePath = join(dir, "state.json");
    const data = { status: "running", runningPid: 42 };
    await writeAtomicJson(filePath, data);
    const content = await readFile(filePath, "utf8");
    assert.ok(content.endsWith("\n"), "file must end with trailing newline");
    const parsed = JSON.parse(content);
    assert.deepEqual(parsed, data, "parsed content must match original data");
    assert.ok(content.includes("  "), "content should use 2-space indentation");
  } finally {
    await rmFile(dir, { recursive: true });
  }
});

// EXEC-03: writeAtomicJson leaves no .tmp file after successful write
test("EXEC-03: writeAtomicJson leaves no .tmp file after successful write", async () => {
  const dir = await (async () => {
    const d = join(tmpdir(), `test-atomic-notmp-${Date.now()}`);
    await mkdir(d, { recursive: true });
    return d;
  })();
  try {
    const filePath = join(dir, "state.json");
    await writeAtomicJson(filePath, { foo: "bar" });
    let tmpExists = false;
    try {
      await readFile(filePath + ".tmp");
      tmpExists = true;
    } catch {
      tmpExists = false;
    }
    assert.equal(tmpExists, false, "no .tmp file should remain after successful write");
  } finally {
    await rmFile(dir, { recursive: true });
  }
});

// EXEC-03: writeAtomicJson uses rename pattern (source-level check)
test("EXEC-03: writeAtomicJson uses rename pattern (source check)", () => {
  assert.ok(
    src.includes('rename(') && src.includes('.tmp'),
    "writeAtomicJson must use writeFile(.tmp) + rename pattern"
  );
});

// --- EXEC-03: initRunState ---

// EXEC-03: initRunState returns correct top-level fields
test("EXEC-03: initRunState returns correct top-level fields", () => {
  const stageNames = ["research", "summarize"];
  const result = initRunState("my-pipeline", "2026-03-23T10-00-00-000Z", stageNames);
  assert.equal(result.pipelineName, "my-pipeline");
  assert.equal(result.runId, "2026-03-23T10-00-00-000Z");
  assert.equal(result.status, "pending");
  assert.equal(result.runningPid, null);
  assert.equal(result.startedAt, null);
  assert.equal(result.completedAt, null);
  assert.equal(result.totalCostUsd, 0);
});

// EXEC-03: initRunState creates stage entries for each stage
test("EXEC-03: initRunState creates stage entries for each stage", () => {
  const stageNames = ["research", "summarize"];
  const result = initRunState("my-pipeline", "run-001", stageNames);
  assert.ok(typeof result.stages === "object", "stages must be an object");
  assert.ok("research" in result.stages, "stages must have research entry");
  assert.ok("summarize" in result.stages, "stages must have summarize entry");
});

// EXEC-03: initRunState stage entries have correct schema
test("EXEC-03: initRunState stage entries have correct schema with all fields pending/null", () => {
  const result = initRunState("pipe", "run-1", ["stage-a"]);
  const stage = result.stages["stage-a"];
  assert.equal(stage.status, "pending");
  assert.equal(stage.startedAt, null);
  assert.equal(stage.completedAt, null);
  assert.equal(stage.durationMs, null);
  assert.equal(stage.costUsd, null);
  assert.equal(stage.outputPath, null);
  assert.equal(stage.exitCode, null);
  assert.equal(stage.retryCount, 0);
});

// AUTOCONT-01: parseClaudeOutput extracts subtype field
test("AUTOCONT-01: parseClaudeOutput extracts subtype from error_max_turns", () => {
  assert.ok(
    src.includes("subtype: result.subtype"),
    "parseClaudeOutput must extract the subtype field from Claude output"
  );
});

// AUTOCONT-02: runAgent has auto-continue logic for error_max_turns
test("AUTOCONT-02: runAgent checks error_max_turns subtype for auto-continue", () => {
  assert.ok(
    src.includes('parsed.subtype === "error_max_turns"'),
    "runAgent must check for error_max_turns subtype to trigger auto-continue"
  );
  assert.ok(
    src.includes("config.autoContinue?.enabled"),
    "runAgent must check autoContinue.enabled in config"
  );
  assert.ok(
    src.includes("autoContinueCount"),
    "runAgent must track continuation count in state"
  );
});

// AUTOCONT-03: auto-continue respects maxContinuations limit
test("AUTOCONT-03: auto-continue has maxContinuations guard", () => {
  assert.ok(
    src.includes("maxContinuations"),
    "auto-continue must reference maxContinuations config"
  );
  assert.ok(
    src.includes("contCount < maxCont"),
    "auto-continue must compare count against limit before continuing"
  );
});

// AUTOCONT-04: auto-continue resets counter on normal completion
test("AUTOCONT-04: auto-continue resets counter on normal completion", () => {
  assert.ok(
    src.includes('parsed.subtype !== "error_max_turns"'),
    "runAgent must reset autoContinueCount when run completes normally"
  );
});

// --- EXEC-03: recoverStalePipelineRuns ---

// Helper: create a temp pipeline run directory with a state.json
async function createTempPipelineRun(baseDir, pipelineName, runId, stateData) {
  const runDir = join(baseDir, pipelineName, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "state.json"), JSON.stringify(stateData, null, 2) + "\n");
  return runDir;
}

// EXEC-03: run with status "running" and dead PID is marked "failed"
test("EXEC-03: recoverStalePipelineRuns marks dead PID run as failed", async () => {
  const dir = join(tmpdir(), `test-recover-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await createTempPipelineRun(dir, "my-pipe", "run-001", {
    status: "running",
    runningPid: 99999999,
    pipelineName: "my-pipe",
    runId: "run-001",
  });
  try {
    const written = [];
    await recoverStalePipelineRuns(dir, async (path, data) => written.push({ path, data }));
    assert.equal(written.length, 1, "should write updated state for dead PID run");
    assert.equal(written[0].data.status, "failed");
    assert.equal(written[0].data.failedReason, "stale_lock_recovered");
    assert.equal(written[0].data.runningPid, null);
    assert.ok(written[0].data.completedAt != null, "completedAt must be set");
  } finally {
    await rmFile(dir, { recursive: true });
  }
});

// EXEC-03: run with status "running" and null PID is marked "failed"
test("EXEC-03: recoverStalePipelineRuns marks null PID run as failed", async () => {
  const dir = join(tmpdir(), `test-recover-nullpid-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await createTempPipelineRun(dir, "my-pipe", "run-002", {
    status: "running",
    runningPid: null,
    pipelineName: "my-pipe",
    runId: "run-002",
  });
  try {
    const written = [];
    await recoverStalePipelineRuns(dir, async (path, data) => written.push({ path, data }));
    assert.equal(written.length, 1, "should write updated state for null PID run");
    assert.equal(written[0].data.status, "failed");
    assert.equal(written[0].data.failedReason, "stale_lock_recovered");
  } finally {
    await rmFile(dir, { recursive: true });
  }
});

// EXEC-03: run with status "running" and alive PID is NOT modified
test("EXEC-03: recoverStalePipelineRuns does not touch run with alive PID", async () => {
  const dir = join(tmpdir(), `test-recover-alive-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await createTempPipelineRun(dir, "my-pipe", "run-003", {
    status: "running",
    runningPid: process.pid,
    pipelineName: "my-pipe",
    runId: "run-003",
  });
  try {
    const written = [];
    await recoverStalePipelineRuns(dir, async (path, data) => written.push({ path, data }));
    assert.equal(written.length, 0, "should NOT write state for alive PID run");
  } finally {
    await rmFile(dir, { recursive: true });
  }
});

// EXEC-03: run with status "completed" is NOT modified
test("EXEC-03: recoverStalePipelineRuns does not touch completed run", async () => {
  const dir = join(tmpdir(), `test-recover-completed-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await createTempPipelineRun(dir, "my-pipe", "run-004", {
    status: "completed",
    runningPid: null,
    pipelineName: "my-pipe",
    runId: "run-004",
  });
  try {
    const written = [];
    await recoverStalePipelineRuns(dir, async (path, data) => written.push({ path, data }));
    assert.equal(written.length, 0, "should NOT modify completed run");
  } finally {
    await rmFile(dir, { recursive: true });
  }
});

// EXEC-03: run with status "failed" is NOT modified
test("EXEC-03: recoverStalePipelineRuns does not touch already-failed run", async () => {
  const dir = join(tmpdir(), `test-recover-failed-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await createTempPipelineRun(dir, "my-pipe", "run-005", {
    status: "failed",
    runningPid: null,
    pipelineName: "my-pipe",
    runId: "run-005",
  });
  try {
    const written = [];
    await recoverStalePipelineRuns(dir, async (path, data) => written.push({ path, data }));
    assert.equal(written.length, 0, "should NOT modify already-failed run");
  } finally {
    await rmFile(dir, { recursive: true });
  }
});

// EXEC-03: non-existent pipelines directory does not throw
test("EXEC-03: recoverStalePipelineRuns silently returns when pipelines dir missing", async () => {
  const nonExistent = join(tmpdir(), `test-recover-nonexistent-${Date.now()}`);
  await assert.doesNotReject(
    () => recoverStalePipelineRuns(nonExistent, async () => {}),
    "should not throw when directory does not exist"
  );
});

// EXEC-03: recoverStalePipelineRuns is wired into startDaemon (source check)
test("EXEC-03: recoverStalePipelineRuns is called in startDaemon (source check)", () => {
  assert.ok(
    src.includes("recoverStalePipelineRuns("),
    "startDaemon must call recoverStalePipelineRuns"
  );
});

// --- DATA-01: buildPipelineWorkerPrompt ---

// DATA-01: includes agent name in prompt
test("DATA-01: buildPipelineWorkerPrompt includes agent name", () => {
  const config = { name: "researcher", maxTurns: 10, workdir: null };
  const stage = { name: "fetch-data", depends_on: [], prompt: null };
  const pipelineCtx = { pipelineName: "my-pipeline", runId: "run-001", stageOutputs: {} };
  const result = buildPipelineWorkerPrompt(config, "/agents/researcher", "/pipelines/my-pipeline/runs/run-001/fetch-data", stage, pipelineCtx);
  assert.ok(result.includes("researcher"), `Expected agent name in prompt, got: ${result}`);
});

// DATA-01: includes pipeline name in prompt
test("DATA-01: buildPipelineWorkerPrompt includes pipeline name", () => {
  const config = { name: "researcher", maxTurns: 10, workdir: null };
  const stage = { name: "fetch-data", depends_on: [], prompt: null };
  const pipelineCtx = { pipelineName: "my-pipeline", runId: "run-001", stageOutputs: {} };
  const result = buildPipelineWorkerPrompt(config, "/agents/researcher", "/pipelines/my-pipeline/runs/run-001/fetch-data", stage, pipelineCtx);
  assert.ok(result.includes("my-pipeline"), `Expected pipeline name in prompt, got: ${result}`);
});

// DATA-01: includes stage name in prompt
test("DATA-01: buildPipelineWorkerPrompt includes stage name", () => {
  const config = { name: "researcher", maxTurns: 10, workdir: null };
  const stage = { name: "fetch-data", depends_on: [], prompt: null };
  const pipelineCtx = { pipelineName: "my-pipeline", runId: "run-001", stageOutputs: {} };
  const result = buildPipelineWorkerPrompt(config, "/agents/researcher", "/pipelines/my-pipeline/runs/run-001/fetch-data", stage, pipelineCtx);
  assert.ok(result.includes("fetch-data"), `Expected stage name in prompt, got: ${result}`);
});

// DATA-02: includes output file path instruction
test("DATA-02: buildPipelineWorkerPrompt includes output file path instruction", () => {
  const config = { name: "researcher", maxTurns: 10, workdir: null };
  const stage = { name: "fetch-data", depends_on: [], prompt: null };
  const pipelineCtx = { pipelineName: "my-pipeline", runId: "run-001", stageOutputs: {} };
  const result = buildPipelineWorkerPrompt(config, "/agents/researcher", "/pipelines/my-pipeline/runs/run-001/fetch-data", stage, pipelineCtx);
  assert.ok(
    result.includes("/pipelines/my-pipeline/runs/run-001/fetch-data/output"),
    `Expected output path in prompt, got: ${result}`
  );
});

// DATA-01: when stage has exactly 1 predecessor and $prev context provided, includes previous stage output path
test("DATA-01: buildPipelineWorkerPrompt injects $prev path when single predecessor", () => {
  const config = { name: "summarizer", maxTurns: 10, workdir: null };
  const stage = { name: "summarize", depends_on: ["fetch-data"], prompt: "Summarize $prev" };
  const prevOutputPath = "/pipelines/my-pipeline/runs/run-001/fetch-data/output";
  const pipelineCtx = {
    pipelineName: "my-pipeline",
    runId: "run-001",
    stageOutputs: { "fetch-data": prevOutputPath },
  };
  const result = buildPipelineWorkerPrompt(config, "/agents/summarizer", "/pipelines/my-pipeline/runs/run-001/summarize", stage, pipelineCtx);
  assert.ok(
    result.includes(prevOutputPath),
    `Expected previous stage output path in prompt, got: ${result}`
  );
  assert.ok(
    result.includes("Previous stage output available at:"),
    `Expected "Previous stage output available at:" prefix, got: ${result}`
  );
});

// DATA-01: when stage has no predecessors, does NOT include previous stage output line
test("DATA-01: buildPipelineWorkerPrompt does NOT include $prev line when no predecessors", () => {
  const config = { name: "researcher", maxTurns: 10, workdir: null };
  const stage = { name: "fetch-data", depends_on: [], prompt: null };
  const pipelineCtx = { pipelineName: "my-pipeline", runId: "run-001", stageOutputs: {} };
  const result = buildPipelineWorkerPrompt(config, "/agents/researcher", "/pipelines/my-pipeline/runs/run-001/fetch-data", stage, pipelineCtx);
  assert.ok(
    !result.includes("Previous stage output available at:"),
    `Should NOT have $prev line when no predecessors. Got: ${result}`
  );
});

// DATA-01: when stage has 2+ predecessors, does NOT include previous stage output line
test("DATA-01: buildPipelineWorkerPrompt does NOT include $prev line when multiple predecessors", () => {
  const config = { name: "merger", maxTurns: 10, workdir: null };
  const stage = { name: "merge", depends_on: ["fetch-a", "fetch-b"], prompt: "Merge outputs" };
  const pipelineCtx = {
    pipelineName: "my-pipeline",
    runId: "run-001",
    stageOutputs: {
      "fetch-a": "/pipelines/my-pipeline/runs/run-001/fetch-a/output",
      "fetch-b": "/pipelines/my-pipeline/runs/run-001/fetch-b/output",
    },
  };
  const result = buildPipelineWorkerPrompt(config, "/agents/merger", "/pipelines/my-pipeline/runs/run-001/merge", stage, pipelineCtx);
  assert.ok(
    !result.includes("Previous stage output available at:"),
    `Should NOT have $prev line when multiple predecessors. Got: ${result}`
  );
});

// DATA-01: when stage has custom prompt, includes it as "Task: <prompt>"
test("DATA-01: buildPipelineWorkerPrompt includes custom prompt as Task", () => {
  const config = { name: "researcher", maxTurns: 10, workdir: null };
  const stage = { name: "fetch-data", depends_on: [], prompt: "Research AI trends in 2026" };
  const pipelineCtx = { pipelineName: "my-pipeline", runId: "run-001", stageOutputs: {} };
  const result = buildPipelineWorkerPrompt(config, "/agents/researcher", "/pipelines/my-pipeline/runs/run-001/fetch-data", stage, pipelineCtx);
  assert.ok(
    result.includes("Task: Research AI trends in 2026"),
    `Expected "Task: ..." in prompt, got: ${result}`
  );
});

// DATA-01: when stage has no custom prompt, does NOT include Task line
test("DATA-01: buildPipelineWorkerPrompt excludes Task line when no custom prompt", () => {
  const config = { name: "researcher", maxTurns: 10, workdir: null };
  const stage = { name: "fetch-data", depends_on: [], prompt: null };
  const pipelineCtx = { pipelineName: "my-pipeline", runId: "run-001", stageOutputs: {} };
  const result = buildPipelineWorkerPrompt(config, "/agents/researcher", "/pipelines/my-pipeline/runs/run-001/fetch-data", stage, pipelineCtx);
  assert.ok(
    !result.includes("Task:"),
    `Should NOT have Task line when no custom prompt. Got: ${result}`
  );
});

// DATA-01: includes maxTurns
test("DATA-01: buildPipelineWorkerPrompt includes maxTurns", () => {
  const config = { name: "researcher", maxTurns: 15, workdir: null };
  const stage = { name: "fetch-data", depends_on: [], prompt: null };
  const pipelineCtx = { pipelineName: "my-pipeline", runId: "run-001", stageOutputs: {} };
  const result = buildPipelineWorkerPrompt(config, "/agents/researcher", "/pipelines/my-pipeline/runs/run-001/fetch-data", stage, pipelineCtx);
  assert.ok(result.includes("15"), `Expected maxTurns (15) in prompt, got: ${result}`);
});

// DATA-01: includes agentDir path (CLAUDE.md reference)
test("DATA-01: buildPipelineWorkerPrompt includes agentDir path", () => {
  const config = { name: "researcher", maxTurns: 10, workdir: null };
  const stage = { name: "fetch-data", depends_on: [], prompt: null };
  const pipelineCtx = { pipelineName: "my-pipeline", runId: "run-001", stageOutputs: {} };
  const result = buildPipelineWorkerPrompt(config, "/agents/researcher", "/pipelines/my-pipeline/runs/run-001/fetch-data", stage, pipelineCtx);
  assert.ok(result.includes("/agents/researcher"), `Expected agentDir in prompt, got: ${result}`);
});

// DATA-01: returns string with no "undefined" tokens
test("DATA-01: buildPipelineWorkerPrompt returns string without undefined", () => {
  const config = { name: "researcher", maxTurns: 10, workdir: null };
  const stage = { name: "fetch-data", depends_on: [], prompt: null };
  const pipelineCtx = { pipelineName: "my-pipeline", runId: "run-001", stageOutputs: {} };
  const result = buildPipelineWorkerPrompt(config, "/agents/researcher", "/pipelines/my-pipeline/runs/run-001/fetch-data", stage, pipelineCtx);
  assert.ok(typeof result === "string", "Should return a string");
  assert.ok(!result.includes("undefined"), `Should not contain 'undefined', got: ${result}`);
});

// --- COEX-01: daemon skip guard for pipeline workers ---

test("COEX-01: daemon skips agents with pipelineRunId set (source check)", () => {
  assert.ok(
    src.includes("pipelineRunId") && src.includes("continue"),
    "daemon loop must check pipelineRunId and skip with continue"
  );
});

test("COEX-01: pipelineRunId is set before runAgent and cleared in finally (source check)", () => {
  assert.ok(
    src.includes("pipelineRunId = pipelineCtx.runId"),
    "runPipelineStage must set pipelineRunId = pipelineCtx.runId before runAgent"
  );
  assert.ok(
    src.includes("pipelineRunId = null"),
    "runPipelineStage must clear pipelineRunId = null in finally block"
  );
  assert.ok(
    src.includes("finally"),
    "runPipelineStage must use try/finally to guarantee pipelineRunId is cleared"
  );
});

// --- COEX-02: auto-eval suppression for pipeline workers ---

test("COEX-02: runAgent accepts suppressEval option (source check)", () => {
  assert.ok(
    src.includes("suppressEval"),
    "runAgent must accept suppressEval option"
  );
  assert.ok(
    src.includes("!suppressEval"),
    "auto-eval block must check !suppressEval flag"
  );
});

test("COEX-02: pipeline workers pass suppressEval=true (source check)", () => {
  assert.ok(
    src.includes("suppressEval: true"),
    "runPipelineStage must pass suppressEval: true to runAgent"
  );
});

// --- GATE-02: parseGateDecision ---

// GATE-02: proceed action extracted from Claude JSON envelope
test("GATE-02: parseGateDecision extracts proceed from Claude envelope", () => {
  const stdout = JSON.stringify({ result: '{ "action": "proceed" }' });
  const result = parseGateDecision(stdout);
  assert.equal(result.action, "proceed");
});

// GATE-02: retry action with feedback extracted from Claude envelope
test("GATE-02: parseGateDecision extracts retry with feedback from Claude envelope", () => {
  const stdout = JSON.stringify({ result: '{ "action": "retry", "feedback": "Needs more detail" }' });
  const result = parseGateDecision(stdout);
  assert.equal(result.action, "retry");
  assert.equal(result.feedback, "Needs more detail");
});

// GATE-02: abort action with reason extracted from Claude envelope
test("GATE-02: parseGateDecision extracts abort with reason from Claude envelope", () => {
  const stdout = JSON.stringify({ result: '{ "action": "abort", "reason": "Fatal error in output" }' });
  const result = parseGateDecision(stdout);
  assert.equal(result.action, "abort");
  assert.equal(result.reason, "Fatal error in output");
});

// GATE-02: raw JSON (no Claude envelope) is still extracted
test("GATE-02: parseGateDecision extracts from raw JSON string (no envelope)", () => {
  const result = parseGateDecision('{ "action": "proceed" }');
  assert.equal(result.action, "proceed");
});

// GATE-02: JSON embedded in markdown code block is extracted
test("GATE-02: parseGateDecision extracts from markdown code block", () => {
  const stdout = '```json\n{ "action": "retry", "feedback": "Fix the intro" }\n```';
  const result = parseGateDecision(stdout);
  assert.equal(result.action, "retry");
  assert.equal(result.feedback, "Fix the intro");
});

// GATE-02: malformed/empty input returns proceed fallback
test("GATE-02: parseGateDecision returns proceed fallback on malformed input", () => {
  const result = parseGateDecision("not valid json at all");
  assert.equal(result.action, "proceed");
});

// GATE-02: valid JSON but unknown action returns proceed fallback
test("GATE-02: parseGateDecision returns proceed fallback on unknown action", () => {
  const result = parseGateDecision('{ "action": "pause" }');
  assert.equal(result.action, "proceed");
});

// GATE-02: null stdout returns proceed fallback
test("GATE-02: parseGateDecision returns proceed fallback on null input", () => {
  const result = parseGateDecision(null);
  assert.equal(result.action, "proceed");
});

// GATE-02: retry with missing feedback field does not crash
test("GATE-02: parseGateDecision handles retry with missing feedback field gracefully", () => {
  const stdout = JSON.stringify({ result: '{ "action": "retry" }' });
  const result = parseGateDecision(stdout);
  assert.equal(result.action, "retry");
  // feedback is undefined — no crash
  assert.equal(result.feedback, undefined);
});

// --- GATE-01: buildGatePrompt ---

// Helper: create a temp output file for buildGatePrompt tests
function makeTempOutputFile(content) {
  const filePath = join(tmpdir(), `gate-test-output-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

// GATE-01: prompt contains pipeline name and stage name
test("GATE-01: buildGatePrompt contains pipeline name and stage name", async () => {
  const filePath = makeTempOutputFile("some output");
  const stage = { name: "research" };
  const pipelineCtx = { pipelineName: "test-pipeline" };
  const prompt = await buildGatePrompt(stage, filePath, pipelineCtx, null);
  assert.ok(prompt.includes("test-pipeline"), `Expected pipeline name in prompt, got: ${prompt}`);
  assert.ok(prompt.includes("research"), `Expected stage name in prompt, got: ${prompt}`);
});

// GATE-01: prompt contains Stage Output section with file content
test("GATE-01: buildGatePrompt contains Stage Output section with file content", async () => {
  const filePath = makeTempOutputFile("this is the stage output content");
  const stage = { name: "research" };
  const pipelineCtx = { pipelineName: "test-pipeline" };
  const prompt = await buildGatePrompt(stage, filePath, pipelineCtx, null);
  assert.ok(prompt.includes("this is the stage output content"), `Expected file content in prompt, got: ${prompt}`);
});

// GATE-01: output content capped at 12000 characters
test("GATE-01: buildGatePrompt caps output content at 12000 characters", async () => {
  const longContent = "x".repeat(20000);
  const filePath = makeTempOutputFile(longContent);
  const stage = { name: "research" };
  const pipelineCtx = { pipelineName: "test-pipeline" };
  const prompt = await buildGatePrompt(stage, filePath, pipelineCtx, null);
  // The truncated content (12000 x's) should be present but not the full 20000
  assert.ok(prompt.includes("x".repeat(100)), "Expected truncated content in prompt");
  assert.ok(!prompt.includes("x".repeat(12001)), "Prompt should not contain more than 12000 x's");
});

// GATE-01: prompt contains feedback section when feedback string provided
test("GATE-01: buildGatePrompt contains feedback section when feedback provided", async () => {
  const filePath = makeTempOutputFile("output here");
  const stage = { name: "research" };
  const pipelineCtx = { pipelineName: "test-pipeline" };
  const prompt = await buildGatePrompt(stage, filePath, pipelineCtx, "Fix the conclusion section");
  assert.ok(prompt.includes("Fix the conclusion section"), `Expected feedback in prompt, got: ${prompt}`);
});

// GATE-01: prompt does NOT contain feedback section when feedback is null
test("GATE-01: buildGatePrompt does NOT contain feedback when null", async () => {
  const filePath = makeTempOutputFile("output here");
  const stage = { name: "research" };
  const pipelineCtx = { pipelineName: "test-pipeline" };
  const prompt = await buildGatePrompt(stage, filePath, pipelineCtx, null);
  assert.ok(!prompt.includes("Previous attempt feedback"), `Should not contain previous attempt feedback section when null, got: ${prompt}`);
});

// GATE-01: prompt contains JSON decision format instructions
test("GATE-01: buildGatePrompt contains JSON decision format instructions", async () => {
  const filePath = makeTempOutputFile("output here");
  const stage = { name: "research" };
  const pipelineCtx = { pipelineName: "test-pipeline" };
  const prompt = await buildGatePrompt(stage, filePath, pipelineCtx, null);
  assert.ok(prompt.includes("proceed"), `Expected "proceed" in prompt, got: ${prompt}`);
  assert.ok(prompt.includes("retry"), `Expected "retry" in prompt, got: ${prompt}`);
  assert.ok(prompt.includes("abort"), `Expected "abort" in prompt, got: ${prompt}`);
});

// GATE-01: handles missing output file gracefully
test("GATE-01: buildGatePrompt handles missing output file gracefully", async () => {
  const stage = { name: "research" };
  const pipelineCtx = { pipelineName: "test-pipeline" };
  const prompt = await buildGatePrompt(stage, "/nonexistent/path/to/output", pipelineCtx, null);
  assert.ok(prompt.includes("no output file found"), `Expected missing file message in prompt, got: ${prompt}`);
});

// --- GATE-03: buildPipelineWorkerPrompt feedback extension ---

// GATE-03: existing tests still pass with no feedback argument (backward compatible)
test("GATE-03: buildPipelineWorkerPrompt backward compatible with no feedback arg", () => {
  const config = { name: "researcher", maxTurns: 10, workdir: null };
  const stage = { name: "fetch-data", depends_on: [], prompt: null };
  const pipelineCtx = { pipelineName: "my-pipeline", runId: "run-001", stageOutputs: {} };
  const result = buildPipelineWorkerPrompt(config, "/agents/researcher", "/pipelines/my-pipeline/runs/run-001/fetch-data", stage, pipelineCtx);
  assert.ok(typeof result === "string", "Should return a string");
  assert.ok(!result.includes("Supervisor feedback"), "Should not include feedback section when no feedback arg");
});

// GATE-03: when feedback string provided, prompt contains supervisor feedback
test("GATE-03: buildPipelineWorkerPrompt includes supervisor feedback when provided", () => {
  const config = { name: "researcher", maxTurns: 10, workdir: null };
  const stage = { name: "fetch-data", depends_on: [], prompt: "Do research" };
  const pipelineCtx = { pipelineName: "my-pipeline", runId: "run-001", stageOutputs: {} };
  const result = buildPipelineWorkerPrompt(config, "/agents/researcher", "/pipelines/my-pipeline/runs/run-001/fetch-data", stage, pipelineCtx, "Fix the intro paragraph");
  assert.ok(result.includes("Supervisor feedback from previous attempt:"), `Expected feedback header, got: ${result}`);
  assert.ok(result.includes("Fix the intro paragraph"), `Expected feedback text, got: ${result}`);
});

// GATE-03: when feedback is null, prompt does NOT contain supervisor feedback
test("GATE-03: buildPipelineWorkerPrompt excludes supervisor feedback when null", () => {
  const config = { name: "researcher", maxTurns: 10, workdir: null };
  const stage = { name: "fetch-data", depends_on: [], prompt: null };
  const pipelineCtx = { pipelineName: "my-pipeline", runId: "run-001", stageOutputs: {} };
  const result = buildPipelineWorkerPrompt(config, "/agents/researcher", "/pipelines/my-pipeline/runs/run-001/fetch-data", stage, pipelineCtx, null);
  assert.ok(!result.includes("Supervisor feedback"), `Should NOT include feedback when null, got: ${result}`);
});

// --- supervisor gates — source assertions ---

// GATE-01: runGateCheck is called inside exitCode === 0 branch of runPipelineStage
test("GATE-01: runGateCheck is called inside exitCode === 0 branch", () => {
  assert.ok(
    src.includes("runGateCheck") && src.includes("exitCode === 0"),
    "runPipelineStage must call runGateCheck inside the exitCode === 0 branch"
  );
});

// GATE-01: GATE_MAX_TURNS constant is set to 5
test("GATE-01: GATE_MAX_TURNS constant equals 5", () => {
  assert.ok(
    src.includes("GATE_MAX_TURNS = 5"),
    "Source must define GATE_MAX_TURNS = 5"
  );
});

// GATE-01: runGateCheck calls spawnClaude with JUDGE_MODEL
test("GATE-01: runGateCheck uses spawnClaude with JUDGE_MODEL", () => {
  assert.ok(
    src.includes("JUDGE_MODEL") && src.includes("spawnClaude"),
    "runGateCheck must call spawnClaude with JUDGE_MODEL"
  );
});

// GATE-03: retryCount incremented and written before re-spawn (crash-safe ordering)
test("GATE-03: retryCount written to disk before loop continues on gate retry", () => {
  // Find the gate retry block and verify writeState appears before gateFeedback assignment
  const retryIdx = src.indexOf('gateDecision.action === "retry"');
  const writeIdx = src.indexOf("await writeState()", retryIdx);
  const feedbackAssignIdx = src.indexOf("gateFeedback = gateDecision.feedback", retryIdx);
  assert.ok(retryIdx !== -1, 'Source must contain gateDecision.action === "retry" check');
  assert.ok(writeIdx !== -1, "Source must call writeState after gate retry decision");
  assert.ok(feedbackAssignIdx !== -1, "Source must assign gateFeedback on retry");
  assert.ok(writeIdx < feedbackAssignIdx, "writeState must appear before gateFeedback assignment (crash-safe)");
});

// GATE-03: gateFeedback is passed to buildPipelineWorkerPrompt
test("GATE-03: gateFeedback is passed to buildPipelineWorkerPrompt", () => {
  assert.ok(
    src.includes("gateFeedback"),
    "Source must use gateFeedback variable"
  );
  assert.ok(
    src.includes("buildPipelineWorkerPrompt(config, agentDir, stageOutputDir, stage, pipelineCtx, gateFeedback)"),
    "buildPipelineWorkerPrompt must receive gateFeedback as 6th argument"
  );
});

// GATE-04: pipeline status set to aborted with abortedReason
test("GATE-04: runPipeline sets status=aborted and abortedReason on abort decision", () => {
  assert.ok(
    src.includes('status = "aborted"') && src.includes("abortedReason"),
    'runPipeline must set status = "aborted" and abortedReason field'
  );
});

// GATE-04: runPipeline checks stageResult.aborted
test("GATE-04: runPipeline checks stageResult.aborted", () => {
  assert.ok(
    src.includes("stageResult.aborted"),
    "runPipeline must check stageResult.aborted to detect supervisor abort"
  );
});

// GATE-05: infrastructure_failure check appears before abort check in decision routing
test("GATE-05: infrastructure_failure handled before abort in decision routing", () => {
  const infraIdx = src.indexOf('gateDecision.action === "infrastructure_failure"');
  const abortIdx = src.indexOf('gateDecision.action === "abort"');
  assert.ok(infraIdx !== -1, 'Source must check gateDecision.action === "infrastructure_failure"');
  assert.ok(abortIdx !== -1, 'Source must check gateDecision.action === "abort"');
  assert.ok(infraIdx < abortIdx, "infrastructure_failure check must appear before abort check");
});

// GATE-05: infrastructure_failure sets stage to failed (not aborted)
test("GATE-05: infrastructure_failure sets stage status to failed not aborted", () => {
  const infraIdx = src.indexOf('gateDecision.action === "infrastructure_failure"');
  const nextDecisionIdx = src.indexOf('gateDecision.action === "proceed"', infraIdx);
  const infraBlock = src.slice(infraIdx, nextDecisionIdx);
  assert.ok(
    infraBlock.includes('status = "failed"') && !infraBlock.includes('status = "aborted"'),
    "infrastructure_failure block must set stage status to failed, not aborted"
  );
});

// Return type: runPipelineStage returns objects not booleans
test("Return type: runPipelineStage returns { success } objects", () => {
  assert.ok(
    src.includes("return { success: true }") && src.includes("return { success: false }"),
    'runPipelineStage must return { success: true } and { success: false } objects, not booleans'
  );
});

// Caller: runPipeline uses stageResult.success
test("Caller: runPipeline checks stageResult.success", () => {
  assert.ok(
    src.includes("stageResult.success"),
    "runPipeline must check stageResult.success (not plain boolean)"
  );
});

// abort-exit-code: runPipeline exits 1 on aborted status
test("abort-exit-code: runPipeline exits 1 on aborted status", () => {
  assert.ok(
    src.includes('failed || runState.status === "aborted"'),
    'runPipeline exit guard must include || runState.status === "aborted"'
  );
});

// abort-reason-display: showPipelineStatus prints abortedReason
test("abort-reason-display: showPipelineStatus prints abortedReason", () => {
  const fnStart = src.indexOf("async function showPipelineStatus(");
  const fnEnd = src.indexOf("\nasync function ", fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd !== -1 ? fnEnd : undefined);
  assert.ok(
    fnBody.includes("abortedReason"),
    "showPipelineStatus must reference abortedReason"
  );
  assert.ok(
    fnBody.includes('state.status === "aborted"') && fnBody.includes("state.abortedReason"),
    "showPipelineStatus must guard abortedReason display on aborted status"
  );
});

// ============================================================================
// INTEGRATION TESTS — exercise real I/O paths with mocked spawnClaude
// ============================================================================

// Helper: create a temp agent directory with config.json and state.json
async function createTempAgent(baseDir, agentName, config = {}, state = {}) {
  const agentDir = join(baseDir, agentName);
  await mkdir(agentDir, { recursive: true });
  const defaultConfig = { model: "sonnet", maxTurns: 3, mission: "test agent", ...config };
  const defaultState = { status: "idle", runCount: 0, consecutiveErrors: 0, sessionId: null, lastRun: null, ...state };
  await writeFile(join(agentDir, "config.json"), JSON.stringify(defaultConfig, null, 2) + "\n");
  await writeFile(join(agentDir, "state.json"), JSON.stringify(defaultState, null, 2) + "\n");
  return agentDir;
}

// Helper: build a mock spawnClaude that returns canned output
function mockSpawnClaude(responses = []) {
  let callIndex = 0;
  const calls = [];
  return {
    fn: async (args, opts) => {
      calls.push({ args, opts });
      if (opts?.onPid) await opts.onPid(process.pid);
      const response = responses[callIndex] ?? { code: 0, stdout: JSON.stringify({ session_id: "test-session", total_cost_usd: 0.001, duration_ms: 500, num_turns: 1, result: "done" }), stderr: "" };
      callIndex++;
      return response;
    },
    calls,
  };
}

// --- Test 1: readAgentConfig reads real files (would have caught infinite recursion) ---
test("INTEG: readAgentConfig reads config.json from disk", async () => {
  const dir = join(tmpdir(), `test-readAgentConfig-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify({ model: "opus", maxTurns: 5, mission: "test" }));
  try {
    const config = await readAgentConfig(dir);
    assert.equal(config.model, "opus");
    assert.equal(config.maxTurns, 5);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("INTEG: readAgentConfig expands workdir $HOME path", async () => {
  const dir = join(tmpdir(), `test-readAgentConfig-workdir-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify({ model: "sonnet", maxTurns: 3, mission: "test", workdir: "$HOME/projects" }));
  try {
    const config = await readAgentConfig(dir);
    const home = process.env.HOME || process.env.USERPROFILE;
    assert.equal(config.workdir, `${home}/projects`);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("INTEG: readAgentConfig throws on missing config.json", async () => {
  const dir = join(tmpdir(), `test-readAgentConfig-missing-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    await assert.rejects(() => readAgentConfig(dir), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

// --- Test 2: runPipelineStage full lifecycle with mocked spawn ---

// Helper: set up temp dirs and tear down after test
async function withTestDirs(fn) {
  const dir = join(tmpdir(), `test-integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const agentsDir = join(dir, "agents");
  const pipelinesDir = join(dir, "pipelines");
  await mkdir(agentsDir, { recursive: true });
  await mkdir(pipelinesDir, { recursive: true });
  _testSetDirs({ agents: agentsDir, pipelines: pipelinesDir });
  try {
    await fn({ dir, agentsDir, pipelinesDir });
  } finally {
    _testResetDirs();
    _testResetSpawnClaude();
    await rm(dir, { recursive: true });
  }
}

test("INTEG: runPipelineStage happy path — gate proceeds", () =>
  withTestDirs(async ({ agentsDir, pipelinesDir }) => {
    await createTempAgent(agentsDir, "test-agent");
    const runDir = join(pipelinesDir, "test-pipe", "runs", "run-001");
    await mkdir(runDir, { recursive: true });

    const stage = { name: "stage-1", agent: "test-agent", depends_on: [], max_retries: 2 };
    const runState = initRunState("test-pipe", "run-001", ["stage-1"]);
    runState.status = "running";
    const statePath = join(runDir, "state.json");
    await writeAtomicJson(statePath, runState);

    const pipelineCtx = { pipelineName: "test-pipe", runId: "run-001", stageOutputs: {} };

    const mock = mockSpawnClaude([
      { code: 0, stdout: JSON.stringify({ session_id: "s1", total_cost_usd: 0.01, duration_ms: 1000, num_turns: 2, result: "ok" }), stderr: "" },
      { code: 0, stdout: JSON.stringify({ result: JSON.stringify({ action: "proceed" }) }), stderr: "" },
    ]);
    _testSetSpawnClaude(mock.fn);

    const result = await runPipelineStage("test-agent", stage, runState, pipelineCtx, statePath);

    assert.equal(result.success, true, "stage should succeed");
    assert.equal(runState.stages["stage-1"].status, "passed");
    assert.ok(runState.stages["stage-1"].costUsd > 0, "cost should be accumulated");
    assert.equal(mock.calls.length, 2, "should call spawnClaude twice (runAgent + gate)");

    // Verify pipelineRunId was cleared (COEX-01)
    const agentState = JSON.parse(await readFile(join(agentsDir, "test-agent", "state.json"), "utf8"));
    assert.equal(agentState.pipelineRunId, null, "pipelineRunId should be cleared after stage");
  })
);

test("INTEG: runPipelineStage — gate retry then proceed", () =>
  withTestDirs(async ({ agentsDir, pipelinesDir }) => {
    await createTempAgent(agentsDir, "test-agent");
    const runDir = join(pipelinesDir, "test-pipe", "runs", "run-002");
    await mkdir(runDir, { recursive: true });

    const stage = { name: "stage-1", agent: "test-agent", depends_on: [], max_retries: 2 };
    const runState = initRunState("test-pipe", "run-002", ["stage-1"]);
    runState.status = "running";
    const statePath = join(runDir, "state.json");
    await writeAtomicJson(statePath, runState);

    const pipelineCtx = { pipelineName: "test-pipe", runId: "run-002", stageOutputs: {} };

    const agentResult = JSON.stringify({ session_id: "s1", total_cost_usd: 0.01, duration_ms: 500, num_turns: 1, result: "ok" });
    const mock = mockSpawnClaude([
      { code: 0, stdout: agentResult, stderr: "" },
      { code: 0, stdout: JSON.stringify({ result: JSON.stringify({ action: "retry", feedback: "Output incomplete, add more detail" }) }), stderr: "" },
      { code: 0, stdout: agentResult, stderr: "" },
      { code: 0, stdout: JSON.stringify({ result: JSON.stringify({ action: "proceed" }) }), stderr: "" },
    ]);
    _testSetSpawnClaude(mock.fn);

    const result = await runPipelineStage("test-agent", stage, runState, pipelineCtx, statePath);

    assert.equal(result.success, true, "stage should succeed after retry");
    assert.equal(runState.stages["stage-1"].status, "passed");
    assert.equal(runState.stages["stage-1"].retryCount, 1, "retryCount should be 1 after one retry");
    assert.equal(mock.calls.length, 4, "should call spawnClaude 4 times (2x runAgent + 2x gate)");
  })
);

test("INTEG: runPipelineStage — gate abort returns aborted flag", () =>
  withTestDirs(async ({ agentsDir, pipelinesDir }) => {
    await createTempAgent(agentsDir, "test-agent");
    const runDir = join(pipelinesDir, "test-pipe", "runs", "run-003");
    await mkdir(runDir, { recursive: true });

    const stage = { name: "stage-1", agent: "test-agent", depends_on: [], max_retries: 2 };
    const runState = initRunState("test-pipe", "run-003", ["stage-1"]);
    runState.status = "running";
    const statePath = join(runDir, "state.json");
    await writeAtomicJson(statePath, runState);

    const pipelineCtx = { pipelineName: "test-pipe", runId: "run-003", stageOutputs: {} };

    const mock = mockSpawnClaude([
      { code: 0, stdout: JSON.stringify({ session_id: "s1", total_cost_usd: 0.01, duration_ms: 500, num_turns: 1, result: "ok" }), stderr: "" },
      { code: 0, stdout: JSON.stringify({ result: JSON.stringify({ action: "abort", reason: "Output contains hallucinated data" }) }), stderr: "" },
    ]);
    _testSetSpawnClaude(mock.fn);

    const result = await runPipelineStage("test-agent", stage, runState, pipelineCtx, statePath);

    assert.equal(result.success, false, "stage should fail");
    assert.equal(result.aborted, true, "should flag as aborted");
    assert.equal(result.reason, "Output contains hallucinated data");
    assert.equal(runState.stages["stage-1"].status, "failed");
    assert.equal(runState.stages["stage-1"].gateDecision, "abort");
  })
);

test("INTEG: runPipelineStage — gate infrastructure failure marks stage failed not aborted", () =>
  withTestDirs(async ({ agentsDir, pipelinesDir }) => {
    await createTempAgent(agentsDir, "test-agent");
    const runDir = join(pipelinesDir, "test-pipe", "runs", "run-004");
    await mkdir(runDir, { recursive: true });

    const stage = { name: "stage-1", agent: "test-agent", depends_on: [], max_retries: 2 };
    const runState = initRunState("test-pipe", "run-004", ["stage-1"]);
    runState.status = "running";
    const statePath = join(runDir, "state.json");
    await writeAtomicJson(statePath, runState);

    const pipelineCtx = { pipelineName: "test-pipe", runId: "run-004", stageOutputs: {} };

    const mock = mockSpawnClaude([
      { code: 0, stdout: JSON.stringify({ session_id: "s1", total_cost_usd: 0.01, duration_ms: 500, num_turns: 1, result: "ok" }), stderr: "" },
      { code: 1, stdout: "", stderr: "Connection refused" },
    ]);
    _testSetSpawnClaude(mock.fn);

    const result = await runPipelineStage("test-agent", stage, runState, pipelineCtx, statePath);

    assert.equal(result.success, false, "stage should fail");
    assert.equal(result.aborted, undefined, "should NOT be flagged as aborted");
    assert.equal(runState.stages["stage-1"].status, "failed");
    assert.equal(runState.stages["stage-1"].gateDecision, "infrastructure_failure");
  })
);

test("INTEG: runPipelineStage — worker fails and exhausts retries", () =>
  withTestDirs(async ({ agentsDir, pipelinesDir }) => {
    await createTempAgent(agentsDir, "test-agent");
    const runDir = join(pipelinesDir, "test-pipe", "runs", "run-005");
    await mkdir(runDir, { recursive: true });

    const stage = { name: "stage-1", agent: "test-agent", depends_on: [], max_retries: 1 };
    const runState = initRunState("test-pipe", "run-005", ["stage-1"]);
    runState.status = "running";
    const statePath = join(runDir, "state.json");
    await writeAtomicJson(statePath, runState);

    const pipelineCtx = { pipelineName: "test-pipe", runId: "run-005", stageOutputs: {} };

    const failResult = { code: 1, stdout: JSON.stringify({ session_id: "s1", total_cost_usd: 0.005, duration_ms: 200 }), stderr: "Agent crashed" };
    const mock = mockSpawnClaude([failResult, failResult]);
    _testSetSpawnClaude(mock.fn);

    const result = await runPipelineStage("test-agent", stage, runState, pipelineCtx, statePath);

    assert.equal(result.success, false, "stage should fail after exhausting retries");
    assert.equal(runState.stages["stage-1"].status, "failed");
    assert.equal(runState.stages["stage-1"].retryCount, 1, "retryCount should reflect max_retries");
  })
);

test("INTEG: runPipelineStage — COEX-01 pipelineRunId lifecycle", () =>
  withTestDirs(async ({ agentsDir, pipelinesDir }) => {
    await createTempAgent(agentsDir, "test-agent");
    const runDir = join(pipelinesDir, "test-pipe", "runs", "run-006");
    await mkdir(runDir, { recursive: true });

    const stage = { name: "stage-1", agent: "test-agent", depends_on: [], max_retries: 0 };
    const runState = initRunState("test-pipe", "run-006", ["stage-1"]);
    runState.status = "running";
    const statePath = join(runDir, "state.json");
    await writeAtomicJson(statePath, runState);

    const pipelineCtx = { pipelineName: "test-pipe", runId: "run-006", stageOutputs: {} };

    let pipelineRunIdDuringRun = null;
    let callCount = 0;
    _testSetSpawnClaude(async (_args, opts) => {
      callCount++;
      if (opts?.onPid) await opts.onPid(process.pid);
      if (callCount === 1) {
        // During runAgent — read pipelineRunId from disk
        const agentState = JSON.parse(await readFile(join(agentsDir, "test-agent", "state.json"), "utf8"));
        pipelineRunIdDuringRun = agentState.pipelineRunId;
        return { code: 0, stdout: JSON.stringify({ session_id: "s1", total_cost_usd: 0.01, duration_ms: 500, num_turns: 1, result: "ok" }), stderr: "" };
      }
      // gate: proceed
      return { code: 0, stdout: JSON.stringify({ result: JSON.stringify({ action: "proceed" }) }), stderr: "" };
    });

    await runPipelineStage("test-agent", stage, runState, pipelineCtx, statePath);

    assert.equal(pipelineRunIdDuringRun, "run-006", "pipelineRunId should be set during execution");

    const agentStateAfter = JSON.parse(await readFile(join(agentsDir, "test-agent", "state.json"), "utf8"));
    assert.equal(agentStateAfter.pipelineRunId, null, "pipelineRunId should be cleared after execution");
  })
);

test("INTEG: runPipelineStage — state.json persisted atomically after each transition", () =>
  withTestDirs(async ({ agentsDir, pipelinesDir }) => {
    await createTempAgent(agentsDir, "test-agent");
    const runDir = join(pipelinesDir, "test-pipe", "runs", "run-007");
    await mkdir(runDir, { recursive: true });

    const stage = { name: "stage-1", agent: "test-agent", depends_on: [], max_retries: 0 };
    const runState = initRunState("test-pipe", "run-007", ["stage-1"]);
    runState.status = "running";
    const statePath = join(runDir, "state.json");
    await writeAtomicJson(statePath, runState);

    const pipelineCtx = { pipelineName: "test-pipe", runId: "run-007", stageOutputs: {} };

    let stateAtRunning = null;
    let callCount = 0;
    _testSetSpawnClaude(async (_args, opts) => {
      callCount++;
      if (opts?.onPid) await opts.onPid(process.pid);
      if (callCount === 1) {
        stateAtRunning = JSON.parse(await readFile(statePath, "utf8"));
        return { code: 0, stdout: JSON.stringify({ session_id: "s1", total_cost_usd: 0.01, duration_ms: 500, num_turns: 1, result: "ok" }), stderr: "" };
      }
      return { code: 0, stdout: JSON.stringify({ result: JSON.stringify({ action: "proceed" }) }), stderr: "" };
    });

    await runPipelineStage("test-agent", stage, runState, pipelineCtx, statePath);

    assert.equal(stateAtRunning.stages["stage-1"].status, "running", "stage should be 'running' during execution");

    const finalState = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(finalState.stages["stage-1"].status, "passed", "stage should be 'passed' after completion");
  })
);

// --- Orchestrator Awareness Skill Injection ---

test("SKILL: createAgent copies orchestrator-awareness skill with resolved template vars", async () => {
  const dir = join(tmpdir(), `test-skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const agentsDir = join(dir, "agents");
  await mkdir(agentsDir, { recursive: true });
  _testSetDirs({ agents: agentsDir });
  try {
    await createAgent({ name: "skill-test", mission: "test skill injection", template: "default" });
    const skillPath = join(agentsDir, "skill-test", "skills", "orchestrator-awareness", "SKILL.md");
    const content = await readFile(skillPath, "utf8");
    assert.ok(content.includes("skill-test"), "Skill should contain resolved agent name");
    assert.ok(!content.includes("{{AGENT_NAME}}"), "Skill should not contain unresolved template vars");
    assert.ok(!content.includes("{{AGENT_DIR}}"), "Skill should not contain unresolved AGENT_DIR");
    assert.ok(!content.includes("{{ORCHESTRATOR_ROOT}}"), "Skill should not contain unresolved ORCHESTRATOR_ROOT");
    assert.ok(content.includes("orchestrator-awareness"), "Skill should have correct frontmatter name");
  } finally {
    _testResetDirs();
    await rm(dir, { recursive: true });
  }
});

test("SKILL: createAgent also copies first-principles skill", async () => {
  const dir = join(tmpdir(), `test-skill-fp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const agentsDir = join(dir, "agents");
  await mkdir(agentsDir, { recursive: true });
  _testSetDirs({ agents: agentsDir });
  try {
    await createAgent({ name: "fp-test", mission: "test both skills", template: "default" });
    const fpPath = join(agentsDir, "fp-test", "skills", "first-principles", "SKILL.md");
    const fpContent = await readFile(fpPath, "utf8");
    assert.ok(fpContent.includes("First Principles"), "first-principles skill should exist");
  } finally {
    _testResetDirs();
    await rm(dir, { recursive: true });
  }
});

// --- Gate Enrichment with Activity Data ---

test("GATE-ACTIVITY: buildGatePrompt includes File Activity section when activityPath provided", async () => {
  const outputPath = makeTempOutputFile("stage output here");
  const activityPath = makeTempOutputFile(
    '{"source":"hook","tool":"Edit","file":"/src/index.ts","action":"write","timestamp":"2026-03-24T20:00:00Z"}\n' +
    '{"source":"hook","tool":"Write","file":"/src/utils.ts","action":"write","timestamp":"2026-03-24T20:01:00Z"}\n'
  );
  const stage = { name: "coding" };
  const pipelineCtx = { pipelineName: "test-pipeline" };
  const prompt = await buildGatePrompt(stage, outputPath, pipelineCtx, null, activityPath);
  assert.ok(prompt.includes("File Activity"), "Prompt should contain File Activity section");
  assert.ok(prompt.includes("/src/index.ts"), "Prompt should list modified file");
  assert.ok(prompt.includes("/src/utils.ts"), "Prompt should list second modified file");
  assert.ok(prompt.includes("modified 2 file(s)"), "Prompt should show file count");
});

test("GATE-ACTIVITY: buildGatePrompt omits File Activity when no activityPath", async () => {
  const outputPath = makeTempOutputFile("stage output");
  const stage = { name: "coding" };
  const pipelineCtx = { pipelineName: "test-pipeline" };
  const prompt = await buildGatePrompt(stage, outputPath, pipelineCtx, null, null);
  assert.ok(!prompt.includes("File Activity"), "Prompt should not contain File Activity when activityPath is null");
});

test("GATE-ACTIVITY: buildGatePrompt omits File Activity when activityPath file missing", async () => {
  const outputPath = makeTempOutputFile("stage output");
  const stage = { name: "coding" };
  const pipelineCtx = { pipelineName: "test-pipeline" };
  const prompt = await buildGatePrompt(stage, outputPath, pipelineCtx, null, "/nonexistent/activity.jsonl");
  assert.ok(!prompt.includes("File Activity"), "Prompt should not contain File Activity when file is missing");
});

test("GATE-ACTIVITY: buildGatePrompt caps file display at 10", async () => {
  const lines = [];
  for (let i = 0; i < 15; i++) {
    lines.push(JSON.stringify({ source: "hook", tool: "Edit", file: `/src/file${i}.ts`, action: "write", timestamp: "2026-03-24T20:00:00Z" }));
  }
  const activityPath = makeTempOutputFile(lines.join("\n") + "\n");
  const outputPath = makeTempOutputFile("output");
  const stage = { name: "coding" };
  const pipelineCtx = { pipelineName: "test-pipeline" };
  const prompt = await buildGatePrompt(stage, outputPath, pipelineCtx, null, activityPath);
  assert.ok(prompt.includes("modified 15 file(s)"), "Prompt should show total count of 15");
  assert.ok(prompt.includes("and 5 more"), "Prompt should indicate 5 more files beyond display cap");
  assert.ok(prompt.includes("/src/file0.ts"), "Prompt should show first file");
  assert.ok(prompt.includes("/src/file9.ts"), "Prompt should show 10th file");
  assert.ok(!prompt.includes("/src/file10.ts"), "Prompt should not show 11th file");
});

test("GATE-ACTIVITY: buildGatePrompt caps activity read at 200 lines", async () => {
  const lines = [];
  for (let i = 0; i < 300; i++) {
    lines.push(JSON.stringify({ source: "hook", tool: "Edit", file: `/src/file${i}.ts`, action: "write", timestamp: "2026-03-24T20:00:00Z" }));
  }
  const activityPath = makeTempOutputFile(lines.join("\n") + "\n");
  const outputPath = makeTempOutputFile("output");
  const stage = { name: "coding" };
  const pipelineCtx = { pipelineName: "test-pipeline" };
  const prompt = await buildGatePrompt(stage, outputPath, pipelineCtx, null, activityPath);
  // Should only see 200 unique files (capped at 200 lines)
  assert.ok(prompt.includes("modified 200 file(s)"), "Should show 200 files (capped from 300 lines)");
});

test("GATE-ACTIVITY: buildGatePrompt deduplicates files", async () => {
  const lines = [
    JSON.stringify({ source: "hook", tool: "Edit", file: "/src/index.ts", action: "write", timestamp: "2026-03-24T20:00:00Z" }),
    JSON.stringify({ source: "hook", tool: "Edit", file: "/src/index.ts", action: "write", timestamp: "2026-03-24T20:01:00Z" }),
    JSON.stringify({ source: "hook", tool: "Write", file: "/src/index.ts", action: "write", timestamp: "2026-03-24T20:02:00Z" }),
  ];
  const activityPath = makeTempOutputFile(lines.join("\n") + "\n");
  const outputPath = makeTempOutputFile("output");
  const stage = { name: "coding" };
  const pipelineCtx = { pipelineName: "test-pipeline" };
  const prompt = await buildGatePrompt(stage, outputPath, pipelineCtx, null, activityPath);
  assert.ok(prompt.includes("modified 1 file(s)"), "Should deduplicate to 1 unique file");
});

test("GATE-ACTIVITY: buildGatePrompt handles malformed JSONL lines gracefully", async () => {
  const lines = [
    '{"source":"hook","tool":"Edit","file":"/src/good.ts","action":"write","timestamp":"2026-03-24T20:00:00Z"}',
    'not valid json',
    '{"source":"hook","tool":"Write","file":"/src/also-good.ts","action":"write","timestamp":"2026-03-24T20:01:00Z"}',
  ];
  const activityPath = makeTempOutputFile(lines.join("\n") + "\n");
  const outputPath = makeTempOutputFile("output");
  const stage = { name: "coding" };
  const pipelineCtx = { pipelineName: "test-pipeline" };
  const prompt = await buildGatePrompt(stage, outputPath, pipelineCtx, null, activityPath);
  assert.ok(prompt.includes("modified 2 file(s)"), "Should parse valid lines and skip malformed ones");
  assert.ok(prompt.includes("/src/good.ts"), "Should include first valid file");
  assert.ok(prompt.includes("/src/also-good.ts"), "Should include second valid file");
});

// --- ENV: AGENT_RUN_DIR injection ---

test("ENV: spawnEnv always includes AGENT_RUN_DIR", () => {
  // Verify the spawnEnv pattern from the source code
  assert.ok(src.includes("AGENT_RUN_DIR: runDir"), "orchestrator.mjs should set AGENT_RUN_DIR in spawnEnv");
  assert.ok(src.includes("AGENT_RUN_DIR"), "orchestrator.mjs should reference AGENT_RUN_DIR");
});

// --- INTEG: runPipelineStage threads activityPath to gate ---

test("INTEG: runPipelineStage passes activityPath to gate check", () =>
  withTestDirs(async ({ agentsDir, pipelinesDir }) => {
    await createTempAgent(agentsDir, "test-agent");
    const runDir = join(pipelinesDir, "test-pipe", "runs", "run-001");
    await mkdir(runDir, { recursive: true });

    const statePath = join(runDir, "state.json");
    const runState = initRunState("test-pipe", "run-001", ["stage-1"]);
    await writeFile(statePath, JSON.stringify(runState, null, 2) + "\n");

    const stage = { name: "stage-1", agent: "test-agent", depends_on: [], prompt: "do stuff", max_retries: 0 };
    const pipelineCtx = { pipelineName: "test-pipe", runId: "run-001", stageOutputs: {} };

    // Write an activity.jsonl in the agent's run directory that the mock will create
    let gatePromptReceived = null;
    let callCount = 0;
    _testSetSpawnClaude(async (args, opts) => {
      callCount++;
      if (opts?.onPid) await opts.onPid(process.pid);
      if (callCount === 1) {
        // Agent run — write activity file to the run dir
        const agentRunDir = opts?.env?.AGENT_RUN_DIR;
        if (agentRunDir) {
          await writeFile(join(agentRunDir, "activity.jsonl"),
            '{"source":"hook","tool":"Edit","file":"/src/test.ts","action":"write","timestamp":"2026-03-24T20:00:00Z"}\n'
          );
        }
        return { code: 0, stdout: JSON.stringify({ session_id: "s1", total_cost_usd: 0.01, duration_ms: 500, num_turns: 1, result: "ok" }), stderr: "" };
      }
      // Gate call — capture the prompt
      gatePromptReceived = args[args.indexOf("-p") + 1];
      return { code: 0, stdout: JSON.stringify({ result: JSON.stringify({ action: "proceed" }) }), stderr: "" };
    });

    await runPipelineStage("test-agent", stage, runState, pipelineCtx, statePath);

    assert.ok(gatePromptReceived, "Gate should have been called");
    assert.ok(gatePromptReceived.includes("File Activity"), "Gate prompt should include File Activity section");
    assert.ok(gatePromptReceived.includes("/src/test.ts"), "Gate prompt should include the activity-tracked file");
  })
);

// --- PARA-01: topoSort levels ---

test("PARA-01: topoSort returns levels — linear chain produces 3 single-stage levels", () => {
  const stages = [
    { name: "A", depends_on: [] },
    { name: "B", depends_on: ["A"] },
    { name: "C", depends_on: ["B"] },
  ];
  const { levels } = topoSort(stages);
  assert.equal(levels.length, 3);
  assert.deepEqual(levels[0].map(s => s.name), ["A"]);
  assert.deepEqual(levels[1].map(s => s.name), ["B"]);
  assert.deepEqual(levels[2].map(s => s.name), ["C"]);
});

test("PARA-01: topoSort returns levels — diamond produces 2 levels: [A,B] then [C]", () => {
  const stages = [
    { name: "A", depends_on: [] },
    { name: "B", depends_on: [] },
    { name: "C", depends_on: ["A", "B"] },
  ];
  const { levels } = topoSort(stages);
  assert.equal(levels.length, 2);
  const level0Names = levels[0].map(s => s.name).sort();
  assert.deepEqual(level0Names, ["A", "B"]);
  assert.deepEqual(levels[1].map(s => s.name), ["C"]);
});

test("PARA-01: topoSort returns levels — single stage produces 1 level", () => {
  const stages = [{ name: "solo", depends_on: [] }];
  const { levels } = topoSort(stages);
  assert.equal(levels.length, 1);
  assert.deepEqual(levels[0].map(s => s.name), ["solo"]);
});

test("PARA-01: topoSort levels — complex DAG with fan-out and fan-in", () => {
  //   A
  //  / \
  // B   C
  //  \ /
  //   D
  const stages = [
    { name: "A", depends_on: [] },
    { name: "B", depends_on: ["A"] },
    { name: "C", depends_on: ["A"] },
    { name: "D", depends_on: ["B", "C"] },
  ];
  const { levels } = topoSort(stages);
  assert.equal(levels.length, 3);
  assert.deepEqual(levels[0].map(s => s.name), ["A"]);
  const level1Names = levels[1].map(s => s.name).sort();
  assert.deepEqual(level1Names, ["B", "C"]);
  assert.deepEqual(levels[2].map(s => s.name), ["D"]);
});

// --- PARA-01: loadPipeline same-agent-same-level validation ---

test("PARA-01: loadPipeline rejects two parallel stages using the same agent", async () => {
  const tmpDir = join(tmpdir(), `orch-test-same-agent-${Date.now()}`);
  const pipelineDir = join(tmpDir, "pipelines", "conflict-test");
  const agentsDir = join(tmpDir, "agents");
  await mkdir(join(agentsDir, "shared-agent"), { recursive: true });
  await writeFile(join(agentsDir, "shared-agent", "config.json"), JSON.stringify({ name: "shared-agent", maxTurns: 10 }));
  await writeFile(join(agentsDir, "shared-agent", "state.json"), "{}");
  await mkdir(pipelineDir, { recursive: true });
  await writeFile(join(pipelineDir, "pipeline.json"), JSON.stringify({
    name: "conflict-test", version: 1,
    stages: [
      { name: "A", agent: "shared-agent", depends_on: [] },
      { name: "B", agent: "shared-agent", depends_on: [] },
    ],
  }));

  _testSetDirs({ agents: agentsDir, pipelines: join(tmpDir, "pipelines") });

  try {
    await assert.rejects(
      () => loadPipeline("conflict-test"),
      (err) => err.message.includes("shared-agent") && err.message.includes("parallel"),
      "Should reject parallel stages with same agent"
    );
  } finally {
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// --- DATA-03: $all in buildPipelineWorkerPrompt ---

test("DATA-03: buildPipelineWorkerPrompt injects $all JSON when multiple predecessors", () => {
  const config = { name: "merger", maxTurns: 10, workdir: null };
  const stage = { name: "merge", depends_on: ["fetch-a", "fetch-b"], prompt: "Merge all outputs" };
  const pipelineCtx = {
    pipelineName: "my-pipeline",
    runId: "run-001",
    stageOutputs: {
      "fetch-a": "/pipelines/my-pipeline/runs/run-001/fetch-a/output",
      "fetch-b": "/pipelines/my-pipeline/runs/run-001/fetch-b/output",
    },
  };
  const result = buildPipelineWorkerPrompt(config, "/agents/merger", "/pipelines/my-pipeline/runs/run-001/merge", stage, pipelineCtx);
  assert.ok(result.includes("All dependency outputs (JSON):"), `Expected $all label, got: ${result}`);
  assert.ok(result.includes("fetch-a"), `Expected fetch-a in $all output`);
  assert.ok(result.includes("fetch-b"), `Expected fetch-b in $all output`);
  // Parse the JSON part
  const jsonMatch = result.match(/All dependency outputs \(JSON\): (.+)/);
  assert.ok(jsonMatch, "Should contain parseable JSON");
  const parsed = JSON.parse(jsonMatch[1]);
  assert.equal(parsed["fetch-a"], "/pipelines/my-pipeline/runs/run-001/fetch-a/output");
  assert.equal(parsed["fetch-b"], "/pipelines/my-pipeline/runs/run-001/fetch-b/output");
});

test("DATA-03: buildPipelineWorkerPrompt does NOT inject $all for single predecessor", () => {
  const config = { name: "summarizer", maxTurns: 10, workdir: null };
  const stage = { name: "summarize", depends_on: ["fetch-data"], prompt: "Summarize" };
  const pipelineCtx = {
    pipelineName: "my-pipeline",
    runId: "run-001",
    stageOutputs: { "fetch-data": "/pipelines/my-pipeline/runs/run-001/fetch-data/output" },
  };
  const result = buildPipelineWorkerPrompt(config, "/agents/summarizer", "/pipelines/my-pipeline/runs/run-001/summarize", stage, pipelineCtx);
  assert.ok(!result.includes("All dependency outputs"), "Should NOT have $all for single dep");
  assert.ok(result.includes("Previous stage output available at:"), "Should have $prev for single dep");
});

// --- createMutex ---

test("createMutex serializes concurrent operations", async () => {
  const mutex = createMutex();
  const log = [];

  const op = (label, delayMs) => mutex(async () => {
    log.push(`${label}-start`);
    await new Promise(r => setTimeout(r, delayMs));
    log.push(`${label}-end`);
  });

  await Promise.all([op("A", 30), op("B", 10), op("C", 10)]);

  // If serialized: A-start, A-end, B-start, B-end, C-start, C-end
  assert.deepEqual(log, ["A-start", "A-end", "B-start", "B-end", "C-start", "C-end"]);
});

// --- Source checks for parallel pipeline support ---

test("PARA-01: source contains createMutex function", () => {
  assert.ok(src.includes("function createMutex()"), "orchestrator.mjs should export createMutex");
});

test("PARA-01: source contains levels in runPipeline", () => {
  assert.ok(src.includes("pipeline.levels"), "runPipeline should iterate over pipeline.levels");
});

test("PARA-01: source contains Promise.all for parallel stages", () => {
  assert.ok(src.includes("Promise.all(level.map"), "runPipeline should use Promise.all for parallel levels");
});

test("PARA-01: runPipeline sums stage costs after execution", () => {
  assert.ok(src.includes("entry.costUsd != null") && src.includes("totalCostUsd +="), "runPipeline should sum stage costs into totalCostUsd");
});

// --- Autoresearch: computeClaudeMdHash ---

test("computeClaudeMdHash returns consistent 12-char hex", () => {
  const h1 = computeClaudeMdHash("hello world");
  const h2 = computeClaudeMdHash("hello world");
  assert.equal(h1, h2);
  assert.equal(h1.length, 12);
  assert.match(h1, /^[0-9a-f]{12}$/);
});

test("computeClaudeMdHash different content gives different hash", () => {
  const h1 = computeClaudeMdHash("version 1");
  const h2 = computeClaudeMdHash("version 2");
  assert.notEqual(h1, h2);
});

// --- Autoresearch: revertClaudeMd ---

test("revertClaudeMd restores latest backup", async () => {
  const tmpDir = join(tmpdir(), `orch-revert-${Date.now()}`);
  const memoryDir = join(tmpDir, ".claude", "memory");
  await mkdir(memoryDir, { recursive: true });

  await writeFile(join(tmpDir, "CLAUDE.md"), "current version");
  await writeFile(join(memoryDir, "CLAUDE.md.bak-20260101-000000"), "old backup");
  await writeFile(join(memoryDir, "CLAUDE.md.bak-20260102-000000"), "latest backup");

  const reverted = await revertClaudeMd(tmpDir);
  assert.ok(reverted);
  const content = await readFile(join(tmpDir, "CLAUDE.md"), "utf8");
  assert.equal(content, "latest backup");

  await rm(tmpDir, { recursive: true, force: true });
});

test("revertClaudeMd returns false when no backups exist", async () => {
  const tmpDir = join(tmpdir(), `orch-revert-empty-${Date.now()}`);
  const memoryDir = join(tmpDir, ".claude", "memory");
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(tmpDir, "CLAUDE.md"), "current");

  const reverted = await revertClaudeMd(tmpDir);
  assert.equal(reverted, false);

  await rm(tmpDir, { recursive: true, force: true });
});

// --- Autoresearch: writeExperimentLog ---

test("writeExperimentLog appends JSONL entries", async () => {
  const tmpDir = join(tmpdir(), `orch-explog-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  await writeExperimentLog(tmpDir, { iteration: 1, score: 6.5 });
  await writeExperimentLog(tmpDir, { iteration: 2, score: 7.0 });

  const content = await readFile(join(tmpDir, "experiments", "autoresearch.jsonl"), "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).iteration, 1);
  assert.equal(JSON.parse(lines[1]).score, 7.0);

  await rm(tmpDir, { recursive: true, force: true });
});

// --- Autoresearch: autoresearchAgent loop ---

test("autoresearchAgent stops after maxIterations", async () => {
  const tmpDir = join(tmpdir(), `orch-ar-iter-${Date.now()}`);
  const agentDir = join(tmpDir, "agents", "test-ar");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "CLAUDE.md"), "# Test Agent");
  await writeFile(join(agentDir, "config.json"), JSON.stringify({ name: "test-ar", maxTurns: 5, model: "sonnet", mission: "test" }));
  await writeFile(join(agentDir, "state.json"), JSON.stringify({
    lastEval: { overall: 7.0 }, evalHistory: [{ overall: 7.0, runTimestamp: "t1" }], evalAverage: 7.0,
  }));

  _testSetDirs({ agents: join(tmpDir, "agents") });
  let runCount = 0;
  _testSetSpawnClaude(async (_args, opts) => {
    runCount++;
    if (opts?.onPid) await opts.onPid(process.pid);
    return { code: 0, stdout: JSON.stringify({ session_id: "s1", total_cost_usd: 0.01, duration_ms: 100, num_turns: 2, result: "ok" }), stderr: "" };
  });

  try {
    await autoresearchAgent("test-ar", {
      maxIterations: 3,
      costBudget: 100,
      minImprovement: 5.0,  // impossible threshold — no improvements
      _evalFn: async () => ({ overall: 7.0, scores: {} }),
      _auditFn: async () => null,
      _improveFn: async () => ({ applied: 0, skipped: 0, total: 0 }),
    });
    assert.equal(runCount, 3, "Should have run exactly 3 times");
  } finally {
    _testResetSpawnClaude();
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("autoresearchAgent stops when cost budget exceeded", async () => {
  const tmpDir = join(tmpdir(), `orch-ar-cost-${Date.now()}`);
  const agentDir = join(tmpDir, "agents", "test-ar-cost");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "CLAUDE.md"), "# Test Agent");
  await writeFile(join(agentDir, "config.json"), JSON.stringify({ name: "test-ar-cost", maxTurns: 5, model: "sonnet", mission: "test" }));
  await writeFile(join(agentDir, "state.json"), JSON.stringify({
    lastEval: { overall: 6.0 }, evalHistory: [{ overall: 6.0, runTimestamp: "t1" }], evalAverage: 6.0,
  }));

  _testSetDirs({ agents: join(tmpDir, "agents") });
  let runCount = 0;
  _testSetSpawnClaude(async (_args, opts) => {
    runCount++;
    if (opts?.onPid) await opts.onPid(process.pid);
    return { code: 0, stdout: JSON.stringify({ session_id: "s1", total_cost_usd: 2.0, duration_ms: 100, num_turns: 2, result: "ok" }), stderr: "" };
  });

  try {
    const result = await autoresearchAgent("test-ar-cost", {
      maxIterations: 10,
      costBudget: 3.0,   // $2/run → budget exceeded after 2 runs
      minImprovement: 5.0,
      _evalFn: async () => ({ overall: 6.0, scores: {} }),
      _auditFn: async () => null,
      _improveFn: async () => ({ applied: 0, skipped: 0, total: 0 }),
    });
    assert.ok(runCount <= 3, `Should stop early due to budget (ran ${runCount} times)`);
    assert.ok(result.totalCostUsd >= 3.0, "Total cost should exceed budget");
  } finally {
    _testResetSpawnClaude();
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("autoresearchAgent applies improvement when score increases", async () => {
  const tmpDir = join(tmpdir(), `orch-ar-improve-${Date.now()}`);
  const agentDir = join(tmpDir, "agents", "test-ar-imp");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "CLAUDE.md"), "# Test Agent");
  await writeFile(join(agentDir, "config.json"), JSON.stringify({ name: "test-ar-imp", maxTurns: 5, model: "sonnet", mission: "test" }));
  await writeFile(join(agentDir, "state.json"), JSON.stringify({
    lastEval: { overall: 5.0 }, evalHistory: [{ overall: 5.0, runTimestamp: "t1" }], evalAverage: 5.0,
  }));

  _testSetDirs({ agents: join(tmpDir, "agents") });
  _testSetSpawnClaude(async (_args, opts) => {
    if (opts?.onPid) await opts.onPid(process.pid);
    return { code: 0, stdout: JSON.stringify({ session_id: "s1", total_cost_usd: 0.01, duration_ms: 100, num_turns: 2, result: "ok" }), stderr: "" };
  });

  let auditCalled = false;
  let improveCalled = false;

  try {
    const result = await autoresearchAgent("test-ar-imp", {
      maxIterations: 1,
      costBudget: 100,
      minImprovement: 0.2,
      _evalFn: async () => ({ overall: 6.5, scores: {} }),  // +1.5 improvement
      _auditFn: async () => { auditCalled = true; return null; },
      _improveFn: async () => { improveCalled = true; return { applied: 2, skipped: 0, total: 2 }; },
    });
    assert.ok(auditCalled, "audit should have been called");
    assert.ok(improveCalled, "improve should have been called");
    assert.equal(result.improvements, 1);
  } finally {
    _testResetSpawnClaude();
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("autoresearchAgent reverts on regression after improvement", async () => {
  const tmpDir = join(tmpdir(), `orch-ar-revert-${Date.now()}`);
  const agentDir = join(tmpDir, "agents", "test-ar-rev");
  const memoryDir = join(agentDir, ".claude", "memory");
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(agentDir, "CLAUDE.md"), "# Improved Agent");
  await writeFile(join(memoryDir, "CLAUDE.md.bak-20260101-000000"), "# Original Agent");
  await writeFile(join(agentDir, "config.json"), JSON.stringify({ name: "test-ar-rev", maxTurns: 5, model: "sonnet", mission: "test" }));
  await writeFile(join(agentDir, "state.json"), JSON.stringify({
    lastEval: { overall: 7.0 }, evalHistory: [{ overall: 7.0, runTimestamp: "t1" }], evalAverage: 7.0,
  }));

  _testSetDirs({ agents: join(tmpDir, "agents") });
  let evalCallCount = 0;
  _testSetSpawnClaude(async (_args, opts) => {
    if (opts?.onPid) await opts.onPid(process.pid);
    return { code: 0, stdout: JSON.stringify({ session_id: "s1", total_cost_usd: 0.01, duration_ms: 100, num_turns: 2, result: "ok" }), stderr: "" };
  });

  try {
    // First iteration: score goes up (triggers improve → sets lastImprovedHash)
    // Second iteration: score drops (triggers revert)
    const result = await autoresearchAgent("test-ar-rev", {
      maxIterations: 2,
      costBudget: 100,
      minImprovement: 0.2,
      _evalFn: async () => {
        evalCallCount++;
        if (evalCallCount === 1) return { overall: 8.0, scores: {} };  // improve
        return { overall: 5.0, scores: {} };  // regress
      },
      _auditFn: async () => null,
      _improveFn: async () => ({ applied: 1, skipped: 0, total: 1 }),
    });
    assert.equal(result.improvements, 1);
    assert.equal(result.reversions, 1);
    // CLAUDE.md should be reverted to the backup
    const content = await readFile(join(agentDir, "CLAUDE.md"), "utf8");
    assert.equal(content, "# Original Agent");
  } finally {
    _testResetSpawnClaude();
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// --- Source checks for autoresearch ---

test("autoresearch: source contains autoresearchAgent function", () => {
  assert.ok(src.includes("async function autoresearchAgent("), "orchestrator.mjs should export autoresearchAgent");
});

test("autoresearch: source contains CLI case", () => {
  assert.ok(src.includes('case "autoresearch"'), "CLI should have autoresearch command");
});

test("autoresearch: source contains computeClaudeMdHash", () => {
  assert.ok(src.includes("function computeClaudeMdHash("), "should have computeClaudeMdHash helper");
});

test("autoresearch: source contains writeExperimentLog", () => {
  assert.ok(src.includes("function writeExperimentLog("), "should have writeExperimentLog helper");
});

// --- Dashboard ---

test("dashboard: source contains showDashboard function", () => {
  assert.ok(src.includes("async function showDashboard()"), "should have showDashboard");
});

test("dashboard: source contains CLI case", () => {
  assert.ok(src.includes('case "dashboard"'), "CLI should have dashboard command");
});

test("dashboard: source includes eval leaders and cost leaders", () => {
  assert.ok(src.includes("Top by Eval"), "dashboard should show top by eval");
  assert.ok(src.includes("Cost Leaders"), "dashboard should show cost leaders");
});

test("dashboard: source includes autoresearch section", () => {
  assert.ok(src.includes("Autoresearch:"), "dashboard should show autoresearch status");
});

// --- Phase 4: Claw Template ---

test("claw template exists with required placeholders", async () => {
  const content = await readFile(join(__dirname, "templates", "claw", "CLAUDE.md"), "utf8");
  assert.ok(content.includes("{{AGENT_NAME}}"), "should have AGENT_NAME placeholder");
  assert.ok(content.includes("{{SUB_MODEL}}"), "should have SUB_MODEL placeholder");
  assert.ok(content.includes("{{SUB_MAX_TURNS}}"), "should have SUB_MAX_TURNS placeholder");
  assert.ok(content.includes("{{WORKFLOW}}"), "should have WORKFLOW placeholder");
  assert.ok(content.includes("Coordinator"), "should mention coordinator pattern");
});

test("createAgent with template=claw resolves sub-session vars", async () => {
  const tmpDir = join(tmpdir(), `orch-claw-${Date.now()}`);
  _testSetDirs({ agents: join(tmpDir, "agents") });

  try {
    await createAgent({
      name: "test-claw",
      template: "claw",
      mission: "Test coordinator",
      model: "opus",
      maxTurns: 50,
      subModel: "haiku",
      subMaxTurns: 30,
      workflow: "Step 1: Research\nStep 2: Implement",
    });
    const claudeMd = await readFile(join(tmpDir, "agents", "test-claw", "CLAUDE.md"), "utf8");
    assert.ok(claudeMd.includes("test-claw"), "should resolve agent name");
    assert.ok(claudeMd.includes("haiku"), "should resolve sub-model");
    assert.ok(claudeMd.includes("30"), "should resolve sub-max-turns");
    assert.ok(claudeMd.includes("Step 1: Research"), "should resolve workflow");
    assert.ok(!claudeMd.includes("{{SUB_MODEL}}"), "should not have unresolved placeholders");
  } finally {
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// --- Phase 5: Variant Competition ---

test("generateVariantSubsets returns correct count", () => {
  const improvements = [
    { section: "a", current: "old-a", suggested: "new-a" },
    { section: "b", current: "old-b", suggested: "new-b" },
    { section: "c", current: "old-c", suggested: "new-c" },
  ];
  const subsets = generateVariantSubsets(improvements, 5);
  assert.equal(subsets.length, 5);
  for (const subset of subsets) {
    assert.ok(subset.length >= 1, "each subset should have at least 1 improvement");
    assert.ok(subset.length <= improvements.length, "each subset should not exceed total improvements");
  }
});

test("generateVariantSubsets with single improvement returns it", () => {
  const improvements = [{ section: "a", current: "old", suggested: "new" }];
  const subsets = generateVariantSubsets(improvements, 3);
  assert.equal(subsets.length, 3);
  for (const subset of subsets) {
    assert.equal(subset.length, 1);
    assert.equal(subset[0].section, "a");
  }
});

test("cloneAgent creates correct structure", async () => {
  const tmpDir = join(tmpdir(), `orch-clone-${Date.now()}`);
  const srcDir = join(tmpDir, "agents", "original");
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, "CLAUDE.md"), "# Original");
  await writeFile(join(srcDir, "config.json"), JSON.stringify({ name: "original" }));
  await writeFile(join(srcDir, "state.json"), JSON.stringify({ status: "idle", runCount: 5 }));

  _testSetDirs({ agents: join(tmpDir, "agents") });
  try {
    await cloneAgent("original", "clone-1", "# Override");
    const cloneMd = await readFile(join(tmpDir, "agents", "clone-1", "CLAUDE.md"), "utf8");
    assert.equal(cloneMd, "# Override");
    const cloneState = JSON.parse(await readFile(join(tmpDir, "agents", "clone-1", "state.json"), "utf8"));
    assert.equal(cloneState.runCount, 0, "variant state should be reset");
  } finally {
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("cleanupVariants removes variants but not original", async () => {
  const tmpDir = join(tmpdir(), `orch-cleanup-${Date.now()}`);
  const origDir = join(tmpDir, "agents", "test-agent");
  const v1Dir = join(tmpDir, "agents", "test-agent-variant-1");
  const v2Dir = join(tmpDir, "agents", "test-agent-variant-2");
  await mkdir(origDir, { recursive: true });
  await mkdir(v1Dir, { recursive: true });
  await mkdir(v2Dir, { recursive: true });
  await writeFile(join(origDir, "CLAUDE.md"), "original");
  await writeFile(join(v1Dir, "CLAUDE.md"), "v1");
  await writeFile(join(v2Dir, "CLAUDE.md"), "v2");

  _testSetDirs({ agents: join(tmpDir, "agents") });
  try {
    await cleanupVariants("test-agent", 2);
    assert.ok(await readFile(join(origDir, "CLAUDE.md"), "utf8"), "original should still exist");
    let v1Exists = true;
    try { await readFile(join(v1Dir, "CLAUDE.md"), "utf8"); } catch { v1Exists = false; }
    assert.equal(v1Exists, false, "variant-1 should be removed");
  } finally {
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("competeAgent picks winner when variant scores higher", async () => {
  const tmpDir = join(tmpdir(), `orch-compete-${Date.now()}`);
  const agentDir = join(tmpDir, "agents", "test-comp");
  await mkdir(join(agentDir, ".claude", "memory"), { recursive: true });
  await writeFile(join(agentDir, "CLAUDE.md"), "# Test old-section-a content");
  await writeFile(join(agentDir, "config.json"), JSON.stringify({ name: "test-comp", maxTurns: 5, model: "sonnet", mission: "test" }));
  await writeFile(join(agentDir, "state.json"), JSON.stringify({ status: "idle", runCount: 0, lastRun: null, lastResult: null, lastError: null }));

  _testSetDirs({ agents: join(tmpDir, "agents") });
  let evalCallCount = 0;
  _testSetSpawnClaude(async (_args, opts) => {
    if (opts?.onPid) await opts.onPid(process.pid);
    return { code: 0, stdout: JSON.stringify({ session_id: "s1", total_cost_usd: 0.01, duration_ms: 100, num_turns: 2, result: "ok" }), stderr: "" };
  });

  try {
    const result = await competeAgent("test-comp", {
      variants: 2,
      message: "test task",
      _evalFn: async (name) => {
        evalCallCount++;
        // Variants score higher than original
        if (name.includes("variant")) return { overall: 8.0, scores: {} };
        return { overall: 5.0, scores: {} };
      },
      _auditFn: async () => ({
        improvements: [
          { section: "test", current: "old-section-a", suggested: "new-section-a", reason: "better" },
        ],
      }),
    });
    assert.ok(result.improved, "should have improved");
    assert.ok(result.winner > 0, "winner should be a variant");
    assert.ok(result.winnerScore > result.baselineScore, "winner score should beat baseline");
  } finally {
    _testResetSpawnClaude();
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// --- Phase 6: Genetic Optimization ---

test("evolveAgent early-stops on no improvement", async () => {
  const tmpDir = join(tmpdir(), `orch-evolve-${Date.now()}`);
  const agentDir = join(tmpDir, "agents", "test-evo");
  await mkdir(join(agentDir, "experiments"), { recursive: true });
  await mkdir(join(agentDir, ".claude", "memory"), { recursive: true });
  await writeFile(join(agentDir, "CLAUDE.md"), "# Test");
  await writeFile(join(agentDir, "config.json"), JSON.stringify({ name: "test-evo", maxTurns: 5, model: "sonnet", mission: "test" }));
  await writeFile(join(agentDir, "state.json"), JSON.stringify({ status: "idle", runCount: 0, lastRun: null, lastResult: null, lastError: null }));

  _testSetDirs({ agents: join(tmpDir, "agents") });
  _testSetSpawnClaude(async (_args, opts) => {
    if (opts?.onPid) await opts.onPid(process.pid);
    return { code: 0, stdout: JSON.stringify({ session_id: "s1", total_cost_usd: 0.01, duration_ms: 100, num_turns: 2, result: "ok" }), stderr: "" };
  });

  try {
    const result = await evolveAgent("test-evo", {
      generations: 5,
      variants: 2,
      _evalFn: async () => ({ overall: 7.0, scores: {} }),
      _auditFn: async () => ({ improvements: [{ section: "a", current: "x", suggested: "y", reason: "z" }] }),
    });
    // Original always wins (all score 7.0) so no improvement → stops after gen 1
    assert.equal(result.generations, 1, "should stop after 1 generation with no improvement");
  } finally {
    _testResetSpawnClaude();
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// --- Source checks for v3.0 ---

test("v3.0: source contains competeAgent", () => {
  assert.ok(src.includes("async function competeAgent("), "should have competeAgent");
});

test("v3.0: source contains evolveAgent", () => {
  assert.ok(src.includes("async function evolveAgent("), "should have evolveAgent");
});

test("v3.0: source contains CLI compete and evolve cases", () => {
  assert.ok(src.includes('case "compete"'), "CLI should have compete command");
  assert.ok(src.includes('case "evolve"'), "CLI should have evolve command");
});

test("v3.0: source contains cloneAgent", () => {
  assert.ok(src.includes("async function cloneAgent("), "should have cloneAgent");
});

test("v3.0: source contains generateVariantSubsets", () => {
  assert.ok(src.includes("function generateVariantSubsets("), "should have generateVariantSubsets");
});

// --- Pipeline list command ---

test("pipeline list: source contains listPipelineRuns function", () => {
  assert.ok(src.includes("async function listPipelineRuns()"), "should have listPipelineRuns");
});

test("pipeline list: source contains CLI case", () => {
  assert.ok(src.includes('case "list":') && src.includes("listPipelineRuns"), "pipeline list CLI case should exist");
});

// --- Per-stage config overrides (COEX-03) ---

test("COEX-03: runPipelineStage applies per-stage model override", () => {
  assert.ok(src.includes("stage.model") && src.includes("config.model = stage.model"), "should apply stage model override");
});

test("COEX-03: runPipelineStage applies per-stage maxTurns override", () => {
  assert.ok(src.includes("stage.maxTurns") && src.includes("config.maxTurns = stage.maxTurns"), "should apply stage maxTurns override");
});

test("COEX-03: runPipelineStage applies per-stage timeout override", () => {
  assert.ok(src.includes("stage.timeout") && src.includes("config.timeoutMs = stage.timeout"), "should apply stage timeout override");
});

// --- Scheduling ---

test("SCHED-01: expandScheduleSugar('hourly') → '0 * * * *'", () => {
  assert.equal(expandScheduleSugar("hourly"), "0 * * * *");
});

test("SCHED-02: expandScheduleSugar('daily 09:00') → '0 9 * * *'", () => {
  assert.equal(expandScheduleSugar("daily 09:00"), "0 9 * * *");
  assert.equal(expandScheduleSugar("daily 23:45"), "45 23 * * *");
});

test("SCHED-03: expandScheduleSugar('weekdays 09:00') → '0 9 * * 1-5'", () => {
  assert.equal(expandScheduleSugar("weekdays 09:00"), "0 9 * * 1-5");
});

test("SCHED-04: expandScheduleSugar('weekly mon 09:00') → '0 9 * * 1'", () => {
  assert.equal(expandScheduleSugar("weekly mon 09:00"), "0 9 * * 1");
  assert.equal(expandScheduleSugar("weekly sun 09:00"), "0 9 * * 0");
  assert.equal(expandScheduleSugar("weekly 09:00"), "0 9 * * 0"); // defaults to Sunday
});

test("SCHED-05: expandScheduleSugar rejects bad input", () => {
  assert.throws(() => expandScheduleSugar("nope"), /Unknown schedule sugar/);
  assert.throws(() => expandScheduleSugar("daily"), /Unknown schedule sugar/);
  assert.throws(() => expandScheduleSugar("daily 25:00"), /Invalid time/);
  assert.throws(() => expandScheduleSugar("weekly xyz 09:00"), /Unknown schedule sugar/);
  assert.throws(() => expandScheduleSugar(""), /Empty schedule sugar/);
  assert.throws(() => expandScheduleSugar(null), /Invalid schedule sugar/);
});

test("SCHED-06: validateCronExpr accepts valid expressions", () => {
  // Should not throw
  validateCronExpr("0 9 * * *");
  validateCronExpr("0 9 * * 1-5");
  validateCronExpr("*/15 * * * *");
  validateCronExpr("0,15,30,45 * * * *");
  validateCronExpr("* * * * *");
  validateCronExpr("59 23 31 12 7"); // 7 is valid for Sunday in cron
  const fields = validateCronExpr("0 9 1-15 * 1,3,5");
  assert.equal(fields.minute, "0");
  assert.equal(fields.dow, "1,3,5");
});

test("SCHED-07: validateCronExpr rejects invalid expressions", () => {
  assert.throws(() => validateCronExpr("0 9 * *"), /5 fields/); // 4 fields
  assert.throws(() => validateCronExpr("0 9 * * * *"), /5 fields/); // 6 fields
  assert.throws(() => validateCronExpr("60 * * * *"), /minute/); // 60 out of range
  assert.throws(() => validateCronExpr("* 24 * * *"), /hour/); // 24 out of range
  assert.throws(() => validateCronExpr("* * 32 * *"), /day-of-month/);
  assert.throws(() => validateCronExpr("* * * 13 *"), /month/);
  assert.throws(() => validateCronExpr("* * * * 8"), /day-of-week/);
  assert.throws(() => validateCronExpr("abc * * * *"), /minute/);
  assert.throws(() => validateCronExpr("5-1 * * * *"), /range/); // reversed range
  assert.throws(() => validateCronExpr(""), /5 fields/);
  assert.throws(() => validateCronExpr(123), /must be a string/);
});

test("SCHED-08: cronToLaunchdPlist produces valid plist XML for simple expression", () => {
  const plist = cronToLaunchdPlist({
    label: "com.agent-orchestrator.test",
    cronExpr: "0 9 * * *",
    nodePath: "/usr/bin/node",
    orchestratorPath: "/tmp/orchestrator.mjs",
    workingDir: "/tmp",
    agentName: "test",
    stdoutPath: "/tmp/out.log",
    stderrPath: "/tmp/err.log",
  });
  assert.ok(plist.includes(`<?xml version="1.0" encoding="UTF-8"?>`));
  assert.ok(plist.includes(`<!DOCTYPE plist`));
  assert.ok(plist.includes(`<key>Label</key>`));
  assert.ok(plist.includes(`<string>com.agent-orchestrator.test</string>`));
  assert.ok(plist.includes(`<key>StartCalendarInterval</key>`));
  // Simple expression → single dict, not array
  assert.ok(!plist.includes(`<array>\n    <dict>`), "should not wrap single interval in array");
  assert.ok(plist.includes(`<key>Minute</key>`));
  assert.ok(plist.includes(`<integer>0</integer>`));
  assert.ok(plist.includes(`<key>Hour</key>`));
  assert.ok(plist.includes(`<integer>9</integer>`));
  // RunAtLoad false
  assert.ok(plist.includes(`<key>RunAtLoad</key>\n  <false/>`));
  // ProgramArguments wiring
  assert.ok(plist.includes(`<string>/usr/bin/node</string>`));
  assert.ok(plist.includes(`<string>/tmp/orchestrator.mjs</string>`));
  assert.ok(plist.includes(`<string>run</string>`));
  assert.ok(plist.includes(`<string>test</string>`));
});

test("SCHED-09: cronToLaunchdPlist unrolls ranges and lists into arrays", () => {
  // Weekday range 1-5 → array of 5 dicts
  const weekdaysInterval = cronToLaunchdInterval("0 9 * * 1-5");
  assert.ok(Array.isArray(weekdaysInterval), "weekday range should yield array");
  assert.equal(weekdaysInterval.length, 5);
  assert.deepEqual(weekdaysInterval.map((d) => d.Weekday), [1, 2, 3, 4, 5]);
  weekdaysInterval.forEach((d) => {
    assert.equal(d.Minute, 0);
    assert.equal(d.Hour, 9);
  });

  // Step expansion: */15 over 0-59 → 4 values
  const stepInterval = cronToLaunchdInterval("*/15 * * * *");
  assert.ok(Array.isArray(stepInterval));
  assert.deepEqual(stepInterval.map((d) => d.Minute), [0, 15, 30, 45]);

  // cron dow=7 (Sunday) normalized to 0
  const sunInterval = cronToLaunchdInterval("0 10 * * 7");
  assert.equal(sunInterval.Weekday, 0);

  // List in minute field
  const listInterval = cronToLaunchdInterval("0,30 9 * * *");
  assert.ok(Array.isArray(listInterval));
  assert.deepEqual(listInterval.map((d) => d.Minute), [0, 30]);

  // Full plist with array renders <array><dict>...</dict><dict>...</dict></array>
  const plist = cronToLaunchdPlist({
    label: "lbl",
    cronExpr: "0 9 * * 1-5",
    nodePath: "/bin/node",
    orchestratorPath: "/o.mjs",
    workingDir: "/",
    agentName: "a",
    stdoutPath: "/o.log",
    stderrPath: "/e.log",
  });
  assert.ok(plist.includes(`<array>`));
  assert.ok(plist.includes(`<key>Weekday</key>`));
  const dictMatches = plist.match(/<dict>/g) || [];
  // outer wrapper dict + one dict per weekday = 6 total
  assert.equal(dictMatches.length, 6);
});

test("SCHED-10: cronToLaunchdPlist errors cleanly on too-complex expressions", () => {
  // Both DoM and DoW set — cron ORs, launchd ANDs: refuse rather than mis-schedule
  assert.throws(
    () => cronToLaunchdInterval("0 9 1 * 1"),
    /both day-of-month and day-of-week/,
  );
  // Range-with-step not in the supported subset — rejected at validation
  assert.throws(
    () => cronToLaunchdInterval("0-30/5 * * * *"),
    /Invalid token/,
  );
  // "* * * * *" — can't express "every minute" via StartCalendarInterval
  assert.throws(
    () => cronToLaunchdInterval("* * * * *"),
    /every minute/,
  );
});

test("SCHED-11: buildCrontabLine round-trip (build, parse, confirm match)", () => {
  const line = buildCrontabLine({
    cronExpr: "0 9 * * 1-5",
    projectRoot: "/proj",
    nodePath: "/usr/bin/node",
    orchestratorPath: "/proj/orchestrator.mjs",
    agentName: "bug-fixer",
  });
  // Line shape: "<expr> <cmd> # agent-orchestrator:<name>"
  assert.ok(line.startsWith("0 9 * * 1-5 "), "must start with the cron expr");
  assert.ok(line.includes("cd /proj"));
  assert.ok(line.includes("/usr/bin/node /proj/orchestrator.mjs run bug-fixer"));
  assert.ok(line.endsWith("# agent-orchestrator:bug-fixer"));
  // Validation happens inside buildCrontabLine
  assert.throws(
    () => buildCrontabLine({
      cronExpr: "bogus",
      projectRoot: "/p",
      nodePath: "/n",
      orchestratorPath: "/o",
      agentName: "a",
    }),
    /5 fields/,
  );
});

test("SCHED-12: buildCrontabLine+stripCrontabForAgent survives strip-then-reinstall cycle", () => {
  const existing = [
    "# my personal entry",
    "0 12 * * * /home/me/lunch.sh",
    "0 9 * * * /dev/null # agent-orchestrator:bug-fixer", // old installed line
    "30 * * * * /home/me/other.sh",
  ].join("\n");

  // Strip removes only the marked line for bug-fixer
  const stripped = stripCrontabForAgent(existing, "bug-fixer");
  assert.ok(!stripped.includes("agent-orchestrator:bug-fixer"));
  assert.ok(stripped.includes("my personal entry"));
  assert.ok(stripped.includes("/home/me/lunch.sh"));
  assert.ok(stripped.includes("/home/me/other.sh"));

  // Does NOT touch a different agent's line
  const twoAgents = existing + "\n15 9 * * * /bin/other # agent-orchestrator:other-agent";
  const strippedOne = stripCrontabForAgent(twoAgents, "bug-fixer");
  assert.ok(strippedOne.includes("agent-orchestrator:other-agent"));

  // Reinstall: build a new line, append, strip again — should come off cleanly
  const newLine = buildCrontabLine({
    cronExpr: "30 9 * * 1-5",
    projectRoot: "/proj",
    nodePath: "/bin/node",
    orchestratorPath: "/proj/orchestrator.mjs",
    agentName: "bug-fixer",
  });
  const reinstalled = stripped + "\n" + newLine;
  assert.ok(reinstalled.includes(newLine));
  const strippedAgain = stripCrontabForAgent(reinstalled, "bug-fixer");
  assert.ok(!strippedAgain.includes("agent-orchestrator:bug-fixer"));
  assert.ok(strippedAgain.includes("my personal entry")); // untouched
});

// Smoke test: installCrontab path with mocked exec (Linux-style flow, OS-agnostic as a unit test)
test("SCHED-13: crontab install/remove path with mocked exec (round-trip)", async () => {
  const tmpDir = join(tmpdir(), `orch-sched-cron-${Date.now()}`);
  const agentDir = join(tmpDir, "agents", "cron-smoke");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "config.json"),
    JSON.stringify({ name: "cron-smoke", mission: "m", model: "sonnet", maxTurns: 5, schedule: null }),
  );
  await writeFile(join(agentDir, "state.json"), JSON.stringify({ status: "idle" }));

  _testSetDirs({ agents: join(tmpDir, "agents") });

  // Fake an empty crontab, capture writes.
  let fakeCrontab = "";
  _testSetExec(async (cmd) => {
    if (cmd === "crontab -l") {
      if (!fakeCrontab) {
        const err = new Error("no crontab for user");
        err.stderr = "no crontab for user";
        throw err;
      }
      return { stdout: fakeCrontab, stderr: "" };
    }
    const m = /^crontab (.+)$/.exec(cmd);
    if (m) {
      const file = m[1];
      fakeCrontab = readFileSync(file, "utf8");
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected exec: ${cmd}`);
  });

  try {
    // We can't directly call the private installCrontab; instead, exercise
    // stripCrontabForAgent + buildCrontabLine which the helper is built from.
    const line = buildCrontabLine({
      cronExpr: "0 9 * * *",
      projectRoot: "/proj",
      nodePath: "/usr/bin/node",
      orchestratorPath: "/proj/orchestrator.mjs",
      agentName: "cron-smoke",
    });
    fakeCrontab = line + "\n";
    // Now simulate a remove: strip the marker line
    const after = stripCrontabForAgent(fakeCrontab, "cron-smoke");
    assert.ok(!after.includes("agent-orchestrator:cron-smoke"));
  } finally {
    _testResetExec();
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// --- Describe (NL → spec → agent) ---

// Helper: build a fake Claude haiku response that wraps a JSON spec in the
// standard output-format=json envelope the orchestrator already parses.
function fakeClaudeDescribeResponse(spec, { cost = 0.001 } = {}) {
  const resultText = typeof spec === "string" ? spec : JSON.stringify(spec);
  return {
    code: 0,
    stdout: JSON.stringify({
      session_id: "s-desc",
      total_cost_usd: cost,
      duration_ms: 100,
      num_turns: 1,
      result: resultText,
    }),
    stderr: "",
  };
}

function goodSpec(overrides = {}) {
  return {
    name: "bug-fixer",
    template: "developer",
    mission: "Scan /projects/foo for bugs and fix exactly one per run, then write a summary to report.md.",
    workdir: "/projects/foo",
    maxTurns: 20,
    model: "sonnet",
    outputFile: "report.md",
    schedule: { cron: "0 9 * * *" },
    rationale: "Developer template for code edits; daily cadence fits the mission.",
    ...overrides,
  };
}

test("DESC-01: parseDescription produces valid spec from mock Claude output", async () => {
  _testSetSpawnClaude(async () => fakeClaudeDescribeResponse(goodSpec()));
  try {
    const { spec, cost } = await parseDescription("Fix one bug per run in /projects/foo, daily 9am.");
    assert.equal(spec.name, "bug-fixer");
    assert.equal(spec.template, "developer");
    assert.equal(spec.maxTurns, 20);
    assert.equal(spec.schedule.cron, "0 9 * * *");
    assert.ok(cost >= 0.001);
  } finally {
    _testResetSpawnClaude();
  }
});

test("DESC-02: parseDescription rejects invalid name", async () => {
  _testSetSpawnClaude(async () =>
    fakeClaudeDescribeResponse(goodSpec({ name: "My Agent" })),
  );
  try {
    await assert.rejects(
      parseDescription("whatever"),
      /Invalid name/,
    );
  } finally {
    _testResetSpawnClaude();
  }
});

test("DESC-03: parseDescription rejects unknown template", async () => {
  _testSetSpawnClaude(async () =>
    fakeClaudeDescribeResponse(goodSpec({ template: "wizard" })),
  );
  try {
    await assert.rejects(
      parseDescription("whatever"),
      /Unknown template/,
    );
  } finally {
    _testResetSpawnClaude();
  }
});

test("DESC-04: parseDescription rejects invalid cron", async () => {
  _testSetSpawnClaude(async () =>
    fakeClaudeDescribeResponse(goodSpec({ schedule: { cron: "bogus expr" } })),
  );
  try {
    await assert.rejects(
      parseDescription("whatever"),
      /5 fields|minute|hour/,
    );
  } finally {
    _testResetSpawnClaude();
  }
});

test("DESC-05: parseDescription strips code fences from Claude result", async () => {
  const fenced = "```json\n" + JSON.stringify(goodSpec()) + "\n```";
  _testSetSpawnClaude(async () => fakeClaudeDescribeResponse(fenced));
  try {
    const { spec } = await parseDescription("whatever");
    assert.equal(spec.name, "bug-fixer");
  } finally {
    _testResetSpawnClaude();
  }
});

test("DESC-05b: extractJsonObject handles preamble + fenced + trailing prose", () => {
  const messy =
    "Here is the spec:\n\n```json\n" +
    JSON.stringify({ a: 1, b: { c: [1, 2] } }) +
    "\n```\n\nLet me know if you need changes.";
  const obj = extractJsonObject(messy);
  assert.deepEqual(obj, { a: 1, b: { c: [1, 2] } });

  // Also: plain embedded object
  const plain = "prefix {\"x\": 1, \"y\": \"ok\"} suffix";
  assert.deepEqual(extractJsonObject(plain), { x: 1, y: "ok" });

  // Robust to brace-strings inside
  const withBraces = `{"msg": "has {braces} in string", "n": 2}`;
  assert.deepEqual(extractJsonObject(withBraces), { msg: "has {braces} in string", n: 2 });

  // Returns null on no JSON
  assert.equal(extractJsonObject("no json here"), null);
  assert.equal(extractJsonObject(""), null);
});

test("DESC-05c: validateDescribeSpec rejects duplicate existing name", () => {
  assert.throws(
    () => validateDescribeSpec(goodSpec(), { existingAgents: ["bug-fixer"] }),
    /already exists/,
  );
});

test("DESC-06: bootstrapAgent stops when domain_encoding >= target", async () => {
  let auditCalls = 0;
  let improveCalls = 0;
  const result = await bootstrapAgent("any-agent", {
    maxIterations: 5,
    costBudget: 10.0,
    _auditFn: async () => {
      auditCalls++;
      return { scores: { domain_encoding: 7 }, overall: 7, costUsd: 0.05 };
    },
    _improveFn: async () => {
      improveCalls++;
      return { applied: 1, skipped: 0, total: 1, costUsd: 0.1 };
    },
  });
  assert.equal(auditCalls, 1);
  assert.equal(improveCalls, 0);
  assert.equal(result.stopped, "score_reached");
  assert.equal(result.finalScore, 7);
  assert.ok(result.cost > 0);
});

test("DESC-07: bootstrapAgent stops at maxIterations", async () => {
  let auditCalls = 0;
  let improveCalls = 0;
  const result = await bootstrapAgent("any-agent", {
    maxIterations: 2,
    costBudget: 10.0,
    _auditFn: async () => {
      auditCalls++;
      return { scores: { domain_encoding: 3 }, overall: 3, costUsd: 0.05 };
    },
    _improveFn: async () => {
      improveCalls++;
      return { applied: 1, skipped: 0, total: 1, costUsd: 0.05 };
    },
  });
  assert.equal(auditCalls, 2, "should audit twice");
  assert.equal(improveCalls, 1, "should improve once between audits");
  assert.equal(result.iterations, 2);
  assert.equal(result.stopped, "iteration_cap");
});

test("DESC-08: bootstrapAgent stops when budget exhausted", async () => {
  let auditCalls = 0;
  const result = await bootstrapAgent("any-agent", {
    maxIterations: 5,
    costBudget: 0.20,   // below ESTIMATED_ITER_COST (0.30) after first audit
    _auditFn: async () => {
      auditCalls++;
      return { scores: { domain_encoding: 2 }, overall: 2, costUsd: 0.05 };
    },
    _improveFn: async () => ({ applied: 1, skipped: 0, total: 1, costUsd: 0.05 }),
  });
  assert.equal(auditCalls, 1, "should audit once then halt on budget");
  assert.equal(result.stopped, "budget_exhausted");
});

test("DESC-09: describeAgent with --dry-run returns spec without creating", async () => {
  const tmpDir = join(tmpdir(), `orch-desc-dry-${Date.now()}`);
  _testSetDirs({ agents: join(tmpDir, "agents") });
  _testSetSpawnClaude(async () => fakeClaudeDescribeResponse(goodSpec({ name: "dry-agent", schedule: null })));
  try {
    const result = await describeAgent("Fix bugs in /projects/foo", { dryRun: true, yes: true });
    assert.equal(result.created, false);
    assert.equal(result.dryRun, true);
    assert.equal(result.spec.name, "dry-agent");
    // No agent dir created
    let exists = true;
    try { readFileSync(join(tmpDir, "agents", "dry-agent", "config.json"), "utf8"); }
    catch { exists = false; }
    assert.equal(exists, false, "dry-run should not create agent directory");
  } finally {
    _testResetSpawnClaude();
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("DESC-09b: describeAgent aborts when user declines confirm", async () => {
  const tmpDir = join(tmpdir(), `orch-desc-abort-${Date.now()}`);
  _testSetDirs({ agents: join(tmpDir, "agents") });
  _testSetSpawnClaude(async () => fakeClaudeDescribeResponse(goodSpec({ name: "abort-agent", schedule: null })));
  _testSetPromptConfirm(async () => false);
  try {
    const result = await describeAgent("Fix bugs in /projects/foo", { yes: false });
    assert.equal(result.created, false);
    assert.equal(result.aborted, true);
  } finally {
    _testResetSpawnClaude();
    _testResetPromptConfirm();
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("DESC-10: describeAgent end-to-end with --yes creates agent, bootstraps, records schedule", async () => {
  const tmpDir = join(tmpdir(), `orch-desc-e2e-${Date.now()}`);
  const agentsDir = join(tmpDir, "agents");
  _testSetDirs({ agents: agentsDir });

  // Claude gets called once during parseDescription; subsequent audit/improve
  // are injected via bootstrap fns below. createAgent does not touch Claude.
  _testSetSpawnClaude(async () =>
    fakeClaudeDescribeResponse(goodSpec({
      name: "e2e-agent",
      // No schedule in this test — testing the no-schedule branch so we don't
      // touch launchctl/crontab during tests.
      schedule: null,
      workdir: null,
    })),
  );

  try {
    const result = await describeAgent("Fix bugs", {
      yes: true,
      noSchedule: true,
      maxIterations: 1,
      costBudget: 1.0,
    });

    assert.equal(result.created, true);
    assert.equal(result.spec.name, "e2e-agent");

    // Verify agent dir + config + CLAUDE.md were produced
    const config = JSON.parse(readFileSync(join(agentsDir, "e2e-agent", "config.json"), "utf8"));
    assert.equal(config.name, "e2e-agent");
    assert.equal(config.template, "developer");
    assert.equal(config.maxTurns, 20);

    const claudeMd = readFileSync(join(agentsDir, "e2e-agent", "CLAUDE.md"), "utf8");
    assert.ok(claudeMd.includes("e2e-agent"));

    // Cost accounting includes the parse call at minimum
    assert.ok(result.totalCost >= 0.001, "total cost should include parse cost");
  } finally {
    _testResetSpawnClaude();
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// Source-level sanity
test("describe: source contains describeAgent, parseDescription, bootstrapAgent", () => {
  assert.ok(src.includes("export async function describeAgent("), "should export describeAgent");
  assert.ok(src.includes("export async function parseDescription("), "should export parseDescription");
  assert.ok(src.includes("export async function bootstrapAgent("), "should export bootstrapAgent");
  assert.ok(src.includes('case "describe"'), "CLI should have describe command");
});

test("describe: meta-prompt template exists with {{DESCRIPTION}} placeholder", async () => {
  const content = await readFile(join(__dirname, "templates", "meta", "describe-prompt.md"), "utf8");
  assert.ok(content.includes("{{DESCRIPTION}}"), "describe-prompt.md should have {{DESCRIPTION}} placeholder");
  assert.ok(content.toLowerCase().includes("json"), "describe-prompt.md should instruct JSON output");
});

// DESC-11: describe list filters by createdBy === "describe"
test("DESC-11: describe list filters by createdBy", async () => {
  const tmpDir = join(tmpdir(), `orch-desc-list-${Date.now()}`);
  const agentsDir = join(tmpDir, "agents");
  await mkdir(agentsDir, { recursive: true });

  // Agent A: created via describe
  await mkdir(join(agentsDir, "desc-a"), { recursive: true });
  await writeFile(
    join(agentsDir, "desc-a", "config.json"),
    JSON.stringify({
      name: "desc-a",
      mission: "Long mission description that should be truncated in the list output.",
      template: "developer",
      model: "sonnet",
      maxTurns: 10,
      workdir: "/projects/foo",
      schedule: { cron: "0 9 * * *" },
      createdBy: "describe",
      created: "2026-04-24T00:00:00Z",
    }),
  );

  // Agent B: created via `create` (no createdBy)
  await mkdir(join(agentsDir, "manual-b"), { recursive: true });
  await writeFile(
    join(agentsDir, "manual-b", "config.json"),
    JSON.stringify({
      name: "manual-b",
      mission: "Manual agent",
      template: "default",
      model: "sonnet",
      maxTurns: 10,
      schedule: null,
      created: "2026-04-24T00:00:00Z",
    }),
  );

  _testSetDirs({ agents: agentsDir });

  // Capture stdout
  const origLog = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(" ")); };

  try {
    await describeList();
  } finally {
    console.log = origLog;
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }

  const output = lines.join("\n");
  assert.ok(output.includes("desc-a"), "should include describe-created agent");
  assert.ok(!output.includes("manual-b"), "should NOT include manually-created agent");
  assert.ok(output.includes("0 9 * * *"), "should show schedule");
});

// DESC-12: createAgent passes createdBy through config.json
test("DESC-12: createAgent passes createdBy through config.json", async () => {
  const tmpDir = join(tmpdir(), `orch-desc-createdBy-${Date.now()}`);
  const agentsDir = join(tmpDir, "agents");
  await mkdir(agentsDir, { recursive: true });
  _testSetDirs({ agents: agentsDir });

  try {
    await createAgent({
      name: "marker-agent",
      mission: "Test createdBy marker",
      template: "default",
      createdBy: "describe",
    });
    const config = JSON.parse(readFileSync(join(agentsDir, "marker-agent", "config.json"), "utf8"));
    assert.equal(config.createdBy, "describe");

    // Sanity: createAgent without createdBy should NOT set the field
    await createAgent({
      name: "plain-agent",
      mission: "Test no marker",
      template: "default",
    });
    const plain = JSON.parse(readFileSync(join(agentsDir, "plain-agent", "config.json"), "utf8"));
    assert.equal(plain.createdBy, undefined, "plain create should not set createdBy");
  } finally {
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// SCHED-14: cron error messages include sugar hints
test("SCHED-14: error messages contain sugar hints", () => {
  // validateCronExpr should mention sugar forms on any error
  try {
    validateCronExpr("bogus");
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err.message.includes("hourly"), "validateCronExpr error should hint at 'hourly' sugar");
    assert.ok(err.message.includes("daily HH:MM"), "should hint at 'daily HH:MM'");
    assert.ok(err.message.includes("weekdays"), "should hint at 'weekdays'");
    assert.ok(err.message.includes("--at"), "should mention --at flag");
  }

  // Another invalid field path
  try {
    validateCronExpr("60 * * * *");
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err.message.includes("minute"), "should still identify the bad field");
    assert.ok(err.message.includes("hourly"), "should still include sugar hint");
  }

  // expandScheduleSugar should list accepted forms on every failure path
  try { expandScheduleSugar("nope"); assert.fail("expected throw"); }
  catch (err) {
    assert.ok(err.message.includes("Accepted forms"), "unknown sugar should list accepted forms");
    assert.ok(err.message.includes("hourly"));
  }
  try { expandScheduleSugar(""); assert.fail("expected throw"); }
  catch (err) {
    assert.ok(err.message.includes("Accepted forms"), "empty sugar should list accepted forms");
  }
  try { expandScheduleSugar(null); assert.fail("expected throw"); }
  catch (err) {
    assert.ok(err.message.includes("Accepted forms"), "non-string sugar should list accepted forms");
  }
});

// SCHED-15: launchctl bootstrap failure → fallback to launchctl load succeeds
test("SCHED-15: launchctl bootstrap → load fallback", async () => {
  const tmpDir = join(tmpdir(), `orch-sched-bootload-${Date.now()}`);
  const agentsDir = join(tmpDir, "agents");
  const launchDir = join(tmpDir, "LaunchAgents");
  await mkdir(join(agentsDir, "bootload-agent"), { recursive: true });
  _testSetDirs({ agents: agentsDir, launchAgents: launchDir });

  let bootstrapCalls = 0;
  let loadCalls = 0;
  _testSetExec(async (cmd) => {
    if (cmd.startsWith("plutil -lint")) return { stdout: "OK", stderr: "" };
    if (cmd.startsWith("launchctl bootout")) return { stdout: "", stderr: "" };
    if (cmd.startsWith("launchctl bootstrap")) {
      bootstrapCalls++;
      const err = new Error("bootstrap failed");
      err.stderr = "Input/output error";
      throw err;
    }
    if (cmd.startsWith("launchctl load")) {
      loadCalls++;
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected exec: ${cmd}`);
  });

  try {
    const result = await installLaunchd("bootload-agent", "0 9 * * *");
    assert.equal(bootstrapCalls, 1, "should attempt bootstrap once");
    assert.equal(loadCalls, 1, "should fall back to load once");
    assert.equal(result.label, "com.agent-orchestrator.bootload-agent");
    // Plist must remain on disk since "install" succeeded via fallback
    const plistPath = join(launchDir, "com.agent-orchestrator.bootload-agent.plist");
    const { readFileSync: _read } = await import("node:fs");
    const plist = _read(plistPath, "utf8");
    assert.ok(plist.includes("<key>Label</key>"), "plist should be present after successful fallback");
  } finally {
    _testResetExec();
    _testResetDirs();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// SCHED-16: both bootstrap and load fail → clear error, no half-installed state
test("SCHED-16: launchctl complete failure cleans up plist", async () => {
  const tmpDir = join(tmpdir(), `orch-sched-bothfail-${Date.now()}`);
  const agentsDir = join(tmpDir, "agents");
  const launchDir = join(tmpDir, "LaunchAgents");
  await mkdir(join(agentsDir, "bothfail-agent"), { recursive: true });
  _testSetDirs({ agents: agentsDir, launchAgents: launchDir });

  _testSetExec(async (cmd) => {
    if (cmd.startsWith("plutil -lint")) return { stdout: "OK", stderr: "" };
    if (cmd.startsWith("launchctl bootout")) return { stdout: "", stderr: "" };
    if (cmd.startsWith("launchctl bootstrap")) {
      const err = new Error("bootstrap failed"); err.stderr = "bad bootstrap"; throw err;
    }
    if (cmd.startsWith("launchctl load")) {
      const err = new Error("load failed"); err.stderr = "bad load"; throw err;
    }
    throw new Error(`unexpected exec: ${cmd}`);
  });

  let threw = null;
  try {
    await installLaunchd("bothfail-agent", "0 9 * * *");
  } catch (err) {
    threw = err;
  }

  const plistPath = join(launchDir, "com.agent-orchestrator.bothfail-agent.plist");
  let plistStillThere = true;
  try {
    const { accessSync } = await import("node:fs");
    accessSync(plistPath);
  } catch {
    plistStillThere = false;
  }

  _testResetExec();
  _testResetDirs();
  await rm(tmpDir, { recursive: true, force: true });

  assert.ok(threw, "installLaunchd should throw when both bootstrap and load fail");
  assert.ok(/bootstrap/.test(threw.message), "error should mention bootstrap failure");
  assert.ok(/load/.test(threw.message), "error should mention load fallback failure");
  // Current behavior: the plist is written before launchctl is invoked. If both fail,
  // the plist is left in place (as an inert file — launchd never loaded it). We want
  // it cleaned up so the system doesn't carry a half-installed artifact.
  assert.equal(plistStillThere, false, "plist should be removed after complete launchctl failure");
});
