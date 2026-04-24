#!/usr/bin/env node

/**
 * Agent Orchestrator — Minimal always-alive agent manager
 *
 * Spawns, manages, and schedules autonomous Claude Code agents.
 * Each agent lives in its own folder with CLAUDE.md (harness), memory, and state.
 * Agents can be run by the daemon, the CLI, or independently via run.sh.
 *
 * Zero dependencies — Node.js built-ins only.
 */

import { spawn, exec } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  appendFile,
  mkdir,
  readdir,
  access,
  rm,
  chmod,
  copyFile,
  cp,
  symlink,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

// --- Constants ---

const ROOT = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const ORCHESTRATOR_PATH = fileURLToPath(import.meta.url);
const AGENTS_DIR = join(ROOT, "agents");
const PIPELINES_DIR = join(ROOT, "pipelines");
const TEMPLATES_DIR = join(ROOT, "templates");
const SHARED_DIR = join(ROOT, "shared");
const USER_SKILLS_DIR = join(
  process.env.HOME || process.env.USERPROFILE,
  ".claude",
  "skills",
);
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const DAEMON_POLL_INTERVAL = 30_000; // 30s
const AGENT_TIMEOUT = 30 * 60 * 1000; // 30min
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const EVAL_EVERY_N_RUNS = 10;
const JUDGE_TEMPLATE = join(ROOT, "templates", "judge", "prompt.md");
const AUDIT_TEMPLATE = join(ROOT, "templates", "judge", "audit-prompt.md");
const JUDGE_MAX_TURNS = 5;
const JUDGE_MODEL = "sonnet";
const GATE_MAX_TURNS = 5;

// --- Gate Prompt Builder ---

export async function buildGatePrompt(stage, outputPath, pipelineCtx, feedback, activityPath) {
  let outputContent = "(no output file found)";
  try {
    const raw = await readFile(outputPath, "utf8");
    outputContent = raw.slice(0, 12000);
  } catch {}

  const feedbackSection = feedback
    ? `\n\nPrevious attempt feedback (reason this stage was retried):\n${feedback}`
    : "";

  // Parse file activity log if available (cap read at 200 lines)
  let activitySection = "";
  if (activityPath) {
    try {
      const raw = await readFile(activityPath, "utf8");
      const lines = raw.trim().split("\n").filter(Boolean).slice(0, 200);
      const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const writtenFiles = [...new Set(entries.filter(e => e.action === "write").map(e => e.file))];
      if (writtenFiles.length > 0) {
        const display = writtenFiles.slice(0, 10);
        const more = writtenFiles.length > 10 ? ` (and ${writtenFiles.length - 10} more)` : "";
        activitySection = `\n\n## File Activity\nThe agent modified ${writtenFiles.length} file(s)${more}:\n${display.map(f => `- ${f}`).join("\n")}`;
      }
    } catch {}
  }

  return [
    `You are a pipeline quality supervisor evaluating stage output.`,
    `Pipeline: "${pipelineCtx.pipelineName}", Stage: "${stage.name}"`,
    `The stage worker has completed. Evaluate whether the output meets quality requirements.`,
    feedbackSection,
    activitySection,
    `\n## Stage Output\n\`\`\`\n${outputContent}\n\`\`\``,
    `\n## Decision`,
    `Respond with ONLY a JSON object, one of:`,
    `- { "action": "proceed" }  — output is acceptable, continue pipeline`,
    `- { "action": "retry", "feedback": "<specific critique>" }  — output has fixable problems, retry stage`,
    `- { "action": "abort", "reason": "<explanation>" }  — output has fatal problems, abort pipeline`,
  ].filter(Boolean).join("\n");
}

// --- Gate Decision Parser ---

export function parseGateDecision(stdout) {
  // Level 1: unwrap Claude's output-format json envelope
  let resultText = stdout;
  try {
    const claudeOutput = JSON.parse(stdout);
    resultText = claudeOutput.result || stdout;
  } catch {}

  // Level 2: extract the gate decision JSON from resultText
  const jsonMatch = resultText && resultText.match(/\{\s*"action"\s*:[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (["proceed", "retry", "abort"].includes(parsed.action)) {
        return parsed;
      }
    } catch {}
  }

  // Fallback: malformed response → proceed with warning (GATE-02)
  console.warn(`[gate] WARNING: malformed supervisor response — treating as "proceed"`);
  return { action: "proceed" };
}

// --- Gate Check ---

async function runGateCheck(stage, outputPath, pipelineCtx, feedback, gateTimeout, activityPath) {
  const prompt = await buildGatePrompt(stage, outputPath, pipelineCtx, feedback, activityPath);
  const args = [
    "--dangerously-skip-permissions",
    "--max-turns", String(GATE_MAX_TURNS),
    "--output-format", "json",
    "--model", JUDGE_MODEL,
    "-p", prompt,
  ];

  let result;
  try {
    result = await _spawnClaudeFn(args, { timeout: gateTimeout ?? AGENT_TIMEOUT });
  } catch (err) {
    return { action: "infrastructure_failure", error: err.message };
  }

  if (result.code !== 0) {
    return { action: "infrastructure_failure", error: result.stderr.slice(0, 500) };
  }

  const parsed = parseClaudeOutput(result.stdout);
  const decision = parseGateDecision(result.stdout);

  console.log(`[gate] Stage "${stage.name}" — decision: ${decision.action}`);

  return { ...decision, costUsd: parsed.costUsd };
}

// --- Helpers ---

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function expandPath(p) {
  if (!p || typeof p !== "string") return p;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return p.replace(/^\$HOME\b/g, home).replace(/^~/g, home);
}

export async function readAgentConfig(agentDir) {
  const config = await readJson(join(agentDir, "config.json"));
  if (config.workdir) config.workdir = expandPath(config.workdir);
  return config;
}

async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
}

export async function writeAtomicJson(filePath, data) {
  const tmp = filePath + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, filePath);
}

export function initRunState(pipelineName, runId, stages) {
  const stageEntries = {};
  for (const name of stages) {
    stageEntries[name] = {
      status: "pending",
      startedAt: null,
      completedAt: null,
      durationMs: null,
      costUsd: null,
      outputPath: null,
      exitCode: null,
      retryCount: 0,
    };
  }
  return {
    pipelineName,
    runId,
    status: "pending",
    runningPid: null,
    startedAt: null,
    completedAt: null,
    totalCostUsd: 0,
    stages: stageEntries,
  };
}

export async function recoverStalePipelineRuns(pipelinesDir = PIPELINES_DIR, writeJsonFn = writeAtomicJson) {
  if (!(await exists(pipelinesDir))) return;

  let pipelineDirs;
  try {
    pipelineDirs = await readdir(pipelinesDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const pipelineEntry of pipelineDirs) {
    if (!pipelineEntry.isDirectory()) continue;
    const runsDir = join(pipelinesDir, pipelineEntry.name, "runs");
    if (!(await exists(runsDir))) continue;

    let runDirs;
    try {
      runDirs = await readdir(runsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const runEntry of runDirs) {
      if (!runEntry.isDirectory()) continue;
      const statePath = join(runsDir, runEntry.name, "state.json");
      if (!(await exists(statePath))) continue;

      let runState;
      try {
        runState = await readJson(statePath);
      } catch {
        continue;
      }

      if (runState.status !== "running") continue;

      const pid = runState.runningPid;
      let isAlive = false;
      if (pid) {
        try {
          process.kill(pid, 0);
          isAlive = true;
        } catch (e) {
          isAlive = e.code === "EPERM";
        }
      }

      if (isAlive) continue;

      runState.status = "failed";
      runState.failedReason = "stale_lock_recovered";
      runState.runningPid = null;
      runState.completedAt = new Date().toISOString();
      await writeJsonFn(statePath, runState);
      console.log(`[recover] stale pipeline run recovered: pipeline "${pipelineEntry.name}" run "${runEntry.name}" (was PID ${pid ?? "unknown"})`);
    }
  }
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function iso() {
  return new Date().toISOString();
}

function pad(str, len) {
  return String(str).padEnd(len);
}

// --- Pipeline ---

export function topoSort(stages) {
  const nameSet = new Set(stages.map(s => s.name));
  for (const stage of stages) {
    for (const dep of (stage.depends_on || [])) {
      if (!nameSet.has(dep))
        throw new Error(`Stage "${stage.name}" depends on unknown stage "${dep}"`);
      if (dep === stage.name)
        throw new Error(`Stage "${stage.name}" depends on itself`);
    }
  }
  const inDegree = new Map(stages.map(s => [s.name, (s.depends_on || []).length]));
  const dependents = new Map(stages.map(s => [s.name, []]));
  for (const stage of stages) {
    for (const dep of (stage.depends_on || [])) {
      dependents.get(dep).push(stage.name);
    }
  }
  let queue = stages.filter(s => inDegree.get(s.name) === 0).map(s => s.name);
  const order = [];
  const levels = [];
  while (queue.length > 0) {
    levels.push(queue.slice());
    const next = [];
    for (const name of queue) {
      order.push(name);
      for (const dep of dependents.get(name)) {
        const newDeg = inDegree.get(dep) - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) next.push(dep);
      }
    }
    queue = next;
  }
  if (order.length !== stages.length) {
    const cycleStages = stages.map(s => s.name).filter(n => !order.includes(n));
    throw new Error(`Circular dependency detected among stages: ${cycleStages.join(", ")}`);
  }
  const stageMap = new Map(stages.map(s => [s.name, s]));
  return {
    order: order.map(n => stageMap.get(n)),
    levels: levels.map(level => level.map(n => stageMap.get(n))),
  };
}

export async function loadPipeline(name) {
  const pipelineDir = join(_pipelinesDir, name);
  const configPath = join(pipelineDir, "pipeline.json");
  const raw = await readJson(configPath);

  if (raw.version !== 1)
    throw new Error(`Pipeline "${name}": unknown version ${raw.version} (only version 1 is supported)`);

  const stageNames = raw.stages.map(s => s.name);
  const uniqueNames = new Set(stageNames);
  if (uniqueNames.size !== stageNames.length) {
    const seen = new Set();
    for (const n of stageNames) {
      if (seen.has(n)) throw new Error(`Pipeline "${name}": duplicate stage name "${n}"`);
      seen.add(n);
    }
  }

  for (const stage of raw.stages) {
    const agentDir = join(_agentsDir, stage.agent);
    if (!(await exists(agentDir)))
      throw new Error(`Pipeline "${name}": stage "${stage.name}" references agent "${stage.agent}" which does not exist`);
  }

  const { order: sortedStages, levels } = topoSort(raw.stages);

  for (const stage of sortedStages) {
    if (stage.prompt && stage.prompt.includes("$prev")) {
      const depCount = (stage.depends_on || []).length;
      if (depCount !== 1)
        throw new Error(`Pipeline "${name}": stage "${stage.name}" uses $prev in prompt but depends_on must have exactly 1 entry (has ${depCount})`);
    }
  }

  // Reject parallel stages that share the same agent (pipelineRunId conflict)
  for (const level of levels) {
    if (level.length <= 1) continue;
    const agents = level.map(s => s.agent);
    const seen = new Set();
    for (let i = 0; i < agents.length; i++) {
      if (seen.has(agents[i]))
        throw new Error(`Pipeline "${name}": stages "${level.find(s => s.agent === agents[i]).name}" and "${level[i].name}" would run in parallel but both use agent "${agents[i]}"`);
      seen.add(agents[i]);
    }
  }

  return { name: raw.name, version: raw.version, stages: sortedStages, levels, raw };
}

export function buildPipelineWorkerPrompt(config, agentDir, stageOutputDir, stage, pipelineCtx, feedback = null) {
  const outputFile = join(stageOutputDir, "output");
  const deps = stage.depends_on || [];
  const prevPath = deps.length === 1 ? pipelineCtx.stageOutputs[deps[0]] : null;

  // $all: map of all dependency outputs for multi-dep stages
  let allOutputs = null;
  if (deps.length > 1) {
    allOutputs = {};
    for (const dep of deps) {
      if (pipelineCtx.stageOutputs[dep]) allOutputs[dep] = pipelineCtx.stageOutputs[dep];
    }
  }

  return [
    `You are agent "${config.name}" running as a pipeline worker.`,
    `Pipeline: "${pipelineCtx.pipelineName}", Stage: "${stage.name}"`,
    `Read your CLAUDE.md at ${join(agentDir, "CLAUDE.md")} for your identity and rules.`,
    `Your agent directory (memory, state): ${agentDir}`,
    prevPath ? `Previous stage output available at: ${prevPath}` : "",
    allOutputs ? `All dependency outputs (JSON): ${JSON.stringify(allOutputs)}` : "",
    `Write your output to: ${outputFile}`,
    `You have ${config.maxTurns} turns total.`,
    `Current date: ${new Date().toISOString()}`,
    feedback ? `\nSupervisor feedback from previous attempt:\n${feedback}` : "",
    stage.prompt ? `\nTask: ${stage.prompt}` : "",
  ].filter(Boolean).join("\n");
}

// --- Registry ---

async function loadAgents() {
  if (!(await exists(_agentsDir))) return [];
  const entries = await readdir(_agentsDir, { withFileTypes: true });
  const agents = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(_agentsDir, entry.name);
    const configPath = join(dir, "config.json");
    if (!(await exists(configPath))) continue;
    try {
      const config = await readJson(configPath);
      if (config.workdir) config.workdir = expandPath(config.workdir);
      const state = await readJson(join(dir, "state.json"));

      agents.push({ name: entry.name, dir, config, state });
    } catch (err) {
      console.error(`  skip ${entry.name}: ${err.message}`);
    }
  }
  return agents;
}

// --- Skills Discovery ---

async function discoverSkills() {
  if (!(await exists(USER_SKILLS_DIR))) return [];
  const entries = await readdir(USER_SKILLS_DIR, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    // Skip first-principles (already copied via shared assets)
    if (name === "first-principles") continue;
    // Try to read the skill description from SKILL.md frontmatter
    const skillMdPath = join(USER_SKILLS_DIR, name, "SKILL.md");
    let description = "";
    try {
      const content = await readFile(skillMdPath, "utf8");
      const descMatch = content.match(/description:\s*>?\s*\n?\s*(.+?)(?:\n---|\n[a-z])/s);
      if (descMatch) {
        description = descMatch[1].replace(/\n\s*/g, " ").trim().slice(0, 100);
      }
    } catch {}
    skills.push({ name, description });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function linkSkillsToAgent(agentDir, skillNames) {
  const linked = [];
  for (const name of skillNames) {
    const sourcePath = join(USER_SKILLS_DIR, name);
    if (!(await exists(sourcePath))) {
      console.log(`  Skill "${name}" not found in ${USER_SKILLS_DIR} — skipping`);
      continue;
    }
    const targetPath = join(agentDir, "skills", name);
    if (await exists(targetPath)) {
      console.log(`  Skill "${name}" already exists — skipping`);
      continue;
    }
    await symlink(sourcePath, targetPath);
    linked.push(name);
  }
  return linked;
}

// --- Create ---

export async function createAgent(opts) {
  const {
    name,
    template = "default",
    mission,
    interval,
    maxTurns = 25,
    model = "sonnet",
    workdir,
    skills = [],
    outputFile = null,
    subModel = "sonnet",
    subMaxTurns = 100,
    workflow = "",
    createdBy = null,
  } = opts;

  if (!name) throw new Error("--name is required");
  if (!mission) throw new Error("--mission is required");

  const agentDir = join(_agentsDir, name);
  const defaultOutputFile = ["researcher", "judge"].includes(template) ? "report.md" : null;
  const resolvedOutputFile = outputFile || defaultOutputFile;
  if (await exists(agentDir))
    throw new Error(`Agent "${name}" already exists at ${agentDir}`);

  // Create directory structure
  await mkdir(join(agentDir, ".claude", "memory"), { recursive: true });
  await mkdir(join(agentDir, "skills"), { recursive: true });
  await mkdir(join(agentDir, "runs"), { recursive: true });

  // Copy shared assets (hooks, first-principles)
  if (await exists(SHARED_DIR)) {
    // Copy hooks settings.json → agent .claude/settings.json
    const sharedSettings = join(SHARED_DIR, "settings.json");
    if (await exists(sharedSettings)) {
      await copyFile(sharedSettings, join(agentDir, ".claude", "settings.json"));
    }

    // Copy first-principles skill → agent skills/
    const fpSkill = join(SHARED_DIR, "skills", "first-principles");
    if (await exists(fpSkill)) {
      await cp(fpSkill, join(agentDir, "skills", "first-principles"), { recursive: true });
    }

    // Copy orchestrator-awareness skill → agent skills/ (with template resolution)
    const oaSkill = join(SHARED_DIR, "skills", "orchestrator-awareness");
    if (await exists(oaSkill)) {
      const oaDest = join(agentDir, "skills", "orchestrator-awareness");
      await cp(oaSkill, oaDest, { recursive: true });
      const oaPath = join(oaDest, "SKILL.md");
      let oaContent = await readFile(oaPath, "utf8");
      oaContent = oaContent
        .replaceAll("{{AGENT_NAME}}", name)
        .replaceAll("{{AGENT_DIR}}", agentDir)
        .replaceAll("{{ORCHESTRATOR_ROOT}}", ROOT);
      await writeFile(oaPath, oaContent);
    }
  }

  // Link user skills if requested
  if (skills.length > 0) {
    const linked = await linkSkillsToAgent(agentDir, skills);
    if (linked.length > 0) {
      console.log(`  Skills linked: ${linked.join(", ")}`);
    }
  }

  // Load and render template CLAUDE.md
  const tmplPath = join(TEMPLATES_DIR, template, "CLAUDE.md");
  if (!(await exists(tmplPath)))
    throw new Error(
      `Template "${template}" not found. Available: ${(await readdir(TEMPLATES_DIR)).join(", ")}`,
    );

  let claudeMd = await readFile(tmplPath, "utf8");
  claudeMd = claudeMd
    .replaceAll("{{AGENT_NAME}}", name)
    .replaceAll("{{MISSION}}", mission)
    .replaceAll("{{AGENT_DIR}}", agentDir)
    .replaceAll("{{WORKDIR}}", workdir || agentDir)
    .replaceAll("{{MODEL}}", model)
    .replaceAll("{{MAX_TURNS}}", String(maxTurns))
    .replaceAll("{{SUB_MODEL}}", subModel)
    .replaceAll("{{SUB_MAX_TURNS}}", String(subMaxTurns))
    .replaceAll("{{WORKFLOW}}", workflow || "Execute the mission step by step, spawning sub-sessions as needed.")
    .replaceAll("{{CREATED}}", iso());

  await writeFile(join(agentDir, "CLAUDE.md"), claudeMd);

  // Config
  const config = {
    name,
    template,
    mission,
    model,
    maxTurns,
    schedule: interval ? { intervalSeconds: parseInt(interval) } : null,
    workdir: workdir || null,
    outputFile: resolvedOutputFile || null,
    created: iso(),
  };
  if (createdBy) config.createdBy = createdBy;
  await writeJson(join(agentDir, "config.json"), config);

  // State
  const state = {
    status: "idle",
    runCount: 0,
    lastRun: null,
    lastResult: null,
    lastError: null,
  };
  await writeJson(join(agentDir, "state.json"), state);

  // Memory
  await writeFile(
    join(agentDir, ".claude", "memory", "MEMORY.md"),
    `# ${name} Memory\n\nAgent created: ${config.created}\nMission: ${mission}\n`,
  );

  // Agent SKILL.md (makes it invocable from any Claude Code session)
  const skillMd = `---
name: ${name}
description: Run the "${name}" agent — ${mission.slice(0, 100)}
---

# ${name}

${mission}

## Run This Agent

\`\`\`bash
node ~/projects/agent-orchestrator/orchestrator.mjs run ${name}
\`\`\`

Or standalone:
\`\`\`bash
~/projects/agent-orchestrator/agents/${name}/run.sh
\`\`\`

## Check Status
\`\`\`bash
node ~/projects/agent-orchestrator/orchestrator.mjs status ${name}
node ~/projects/agent-orchestrator/orchestrator.mjs logs ${name}
\`\`\`
`;
  await writeFile(join(agentDir, "SKILL.md"), skillMd);

  // Standalone runner
  const runSh = `#!/usr/bin/env bash
# Standalone runner for agent "${name}"
# Usage: ./run.sh [additional claude args...]
DIR="$(cd "$(dirname "$0")" && pwd)"
NAME="$(basename "$DIR")"
MODEL=$(node -e "process.stdout.write(require('./config.json').model)" 2>/dev/null || echo "sonnet")
MAX_TURNS=$(node -e "process.stdout.write(String(require('./config.json').maxTurns))" 2>/dev/null || echo "25")

cd "$DIR"
exec ${CLAUDE_BIN} \\
  --dangerously-skip-permissions \\
  --max-turns "$MAX_TURNS" \\
  --model "$MODEL" \\
  -p "You are agent '$NAME'. Read your CLAUDE.md for identity and instructions. Execute your mission. Date: $(date -Iseconds)" \\
  "$@"
`;
  const runShPath = join(agentDir, "run.sh");
  await writeFile(runShPath, runSh);
  await chmod(runShPath, 0o755);

  console.log(`Agent "${name}" created`);
  console.log(`  Path:     ${agentDir}`);
  console.log(`  Template: ${template}`);
  console.log(`  Model:    ${model}`);
  console.log(`  Turns:    ${maxTurns}`);
  if (config.schedule)
    console.log(`  Schedule: every ${config.schedule.intervalSeconds}s`);
  if (workdir) console.log(`  Workdir:  ${workdir}`);
  console.log(`\n  Run: node orchestrator.mjs run ${name}`);
  console.log(`  Or:  ./agents/${name}/run.sh`);
}

// --- Describe (natural language → agent) ---

const DESCRIBE_TEMPLATE = join(TEMPLATES_DIR, "meta", "describe-prompt.md");
const DESCRIBE_MODEL = "haiku";
const DESCRIBE_MAX_TURNS = 1;
const KNOWN_TEMPLATES = ["default", "developer", "researcher", "claw"];
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;

// Pull the first balanced JSON object out of a string. Tolerates code fences,
// preamble, and trailing prose — but the spec itself must be valid JSON.
export function extractJsonObject(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  // Strip ``` fences if present (```json ... ``` or ``` ... ```)
  let s = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(s);
  if (fence) s = fence[1].trim();
  const first = s.indexOf("{");
  if (first === -1) return null;
  // Walk forward tracking brace depth, respecting strings
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = first; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(first, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

export function validateDescribeSpec(spec, { existingAgents = [] } = {}) {
  if (!spec || typeof spec !== "object") {
    throw new Error("Spec must be an object");
  }
  if (typeof spec.name !== "string" || !AGENT_NAME_RE.test(spec.name)) {
    throw new Error(
      `Invalid name "${spec.name}" — must be kebab-case, 1-30 chars, [a-z0-9-], start with [a-z0-9]`,
    );
  }
  if (existingAgents.includes(spec.name)) {
    throw new Error(`Agent "${spec.name}" already exists`);
  }
  if (!KNOWN_TEMPLATES.includes(spec.template)) {
    throw new Error(
      `Unknown template "${spec.template}" — must be one of: ${KNOWN_TEMPLATES.join(", ")}`,
    );
  }
  if (typeof spec.mission !== "string" || spec.mission.trim().length < 10) {
    throw new Error(`Mission must be a non-trivial string (got: ${JSON.stringify(spec.mission)})`);
  }
  if (!(Number.isInteger(spec.maxTurns) && spec.maxTurns >= 1 && spec.maxTurns <= 100)) {
    throw new Error(`maxTurns must be an integer 1-100 (got: ${spec.maxTurns})`);
  }
  if (spec.model != null && typeof spec.model !== "string") {
    throw new Error(`model must be a string or null`);
  }
  if (spec.workdir != null && typeof spec.workdir !== "string") {
    throw new Error(`workdir must be a string or null`);
  }
  if (spec.outputFile != null && typeof spec.outputFile !== "string") {
    throw new Error(`outputFile must be a string or null`);
  }
  if (spec.schedule != null) {
    if (typeof spec.schedule !== "object") {
      throw new Error(`schedule must be an object or null`);
    }
    const { cron, at } = spec.schedule;
    if (cron && at) throw new Error(`schedule must have 'cron' OR 'at', not both`);
    if (!cron && !at) throw new Error(`schedule must have 'cron' or 'at'`);
    if (cron) validateCronExpr(cron);
    if (at) expandScheduleSugar(at); // throws if invalid
  }
  return true;
}

// Call Claude (haiku) with the describe meta-prompt. Returns { spec, cost, raw }.
export async function parseDescription(description, { existingAgents = [] } = {}) {
  if (typeof description !== "string" || !description.trim()) {
    throw new Error("Description must be a non-empty string");
  }
  let prompt = await readFile(DESCRIBE_TEMPLATE, "utf8");
  prompt = prompt.replaceAll("{{DESCRIPTION}}", description.trim());

  const args = [
    "--dangerously-skip-permissions",
    "--max-turns",
    String(DESCRIBE_MAX_TURNS),
    "--output-format",
    "json",
    "--model",
    DESCRIBE_MODEL,
    "-p",
    prompt,
  ];

  const { code, stdout, stderr } = await _spawnClaudeFn(args, { timeout: 2 * 60 * 1000 });
  if (code !== 0) {
    throw new Error(`parseDescription: claude exited ${code}: ${(stderr || "").slice(0, 300)}`);
  }

  let claudeOutput;
  try {
    claudeOutput = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`parseDescription: could not parse claude stdout as JSON: ${err.message}`);
  }
  const resultText = claudeOutput.result ?? "";
  const cost = typeof claudeOutput.total_cost_usd === "number" ? claudeOutput.total_cost_usd : 0;

  const spec = extractJsonObject(resultText);
  if (!spec) {
    throw new Error(
      `parseDescription: could not extract JSON spec from claude result.\nResult was: ${String(resultText).slice(0, 500)}`,
    );
  }

  validateDescribeSpec(spec, { existingAgents });
  return { spec, cost, raw: resultText };
}

// Bootstrap loop: audit → if score low and budget allows → improve → re-audit.
// Returns { iterations, finalScore, cost, stopped }.
export async function bootstrapAgent(name, {
  maxIterations = 2,
  costBudget = 1.0,
  targetScore = 6,
  _auditFn = auditAgent,
  _improveFn = improveAgent,
} = {}) {
  // Rough floor for another audit+improve cycle
  const ESTIMATED_ITER_COST = 0.30;

  let iterations = 0;
  let totalCost = 0;
  let lastAudit = null;
  let stopped = "cap";

  while (iterations < maxIterations) {
    const audit = await _auditFn(name);
    const auditCost = (audit && typeof audit.costUsd === "number") ? audit.costUsd : 0;
    totalCost += auditCost;
    lastAudit = audit;

    const score = audit?.scores?.domain_encoding ?? null;
    iterations++;

    if (score != null && score >= targetScore) {
      stopped = "score_reached";
      break;
    }

    if (totalCost + ESTIMATED_ITER_COST > costBudget) {
      stopped = "budget_exhausted";
      break;
    }

    if (iterations >= maxIterations) {
      stopped = "iteration_cap";
      break;
    }

    const improveResult = await _improveFn(name, { apply: true });
    const improveCost = (improveResult && typeof improveResult.costUsd === "number") ? improveResult.costUsd : 0;
    totalCost += improveCost;

    if (totalCost + ESTIMATED_ITER_COST > costBudget) {
      stopped = "budget_exhausted";
      break;
    }
  }

  return {
    iterations,
    finalScore: lastAudit?.scores?.domain_encoding ?? null,
    finalOverall: lastAudit?.overall ?? null,
    cost: totalCost,
    stopped,
  };
}

function printDescribeSpec(spec) {
  console.log(`\nParsed spec:`);
  console.log(`  Name:       ${spec.name}`);
  console.log(`  Template:   ${spec.template}`);
  console.log(`  Model:      ${spec.model || "sonnet"}`);
  console.log(`  Max turns:  ${spec.maxTurns}`);
  console.log(`  Workdir:    ${spec.workdir || "(agent dir)"}`);
  console.log(`  Output:     ${spec.outputFile || "(none)"}`);
  if (spec.schedule) {
    const s = spec.schedule.cron ? `cron: ${spec.schedule.cron}` : `at: ${spec.schedule.at}`;
    console.log(`  Schedule:   ${s}`);
  } else {
    console.log(`  Schedule:   (none)`);
  }
  console.log(`  Mission:    ${spec.mission}`);
  if (spec.rationale) console.log(`  Rationale:  ${spec.rationale}`);
  console.log();
}

// Zero-dep interactive confirm. Returns boolean. Injectable for tests.
let _promptConfirmFn = async (question) => {
  const readline = await import("node:readline");
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test((answer || "").trim()));
    });
    rl.on("SIGINT", () => { rl.close(); resolve(false); });
  });
};
export function _testSetPromptConfirm(fn) { _promptConfirmFn = fn; }
export function _testResetPromptConfirm() {
  _promptConfirmFn = async (question) => {
    const readline = await import("node:readline");
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${question} [y/N] `, (answer) => {
        rl.close();
        resolve(/^y(es)?$/i.test((answer || "").trim()));
      });
      rl.on("SIGINT", () => { rl.close(); resolve(false); });
    });
  };
}

// End-to-end: NL description → parsed spec → created agent → bootstrapped → scheduled.
export async function describeAgent(description, opts = {}) {
  const {
    yes = false,
    dryRun = false,
    noBootstrap = false,
    noSchedule = false,
    maxIterations = 2,
    costBudget = 1.0,
    model: modelOverride = null,
  } = opts;

  // List existing agents so validation can reject duplicates early
  let existingAgents = [];
  try {
    const entries = await readdir(_agentsDir, { withFileTypes: true });
    existingAgents = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // agents dir may not exist yet; that's fine
  }

  console.log(`Parsing description via Claude (${DESCRIBE_MODEL})...`);
  const { spec, cost: parseCost } = await parseDescription(description, { existingAgents });

  if (modelOverride) spec.model = modelOverride;

  printDescribeSpec(spec);

  let totalCost = parseCost;

  if (dryRun) {
    console.log(`[dry-run] Would create agent "${spec.name}". No files written.`);
    console.log(`  Parse cost: $${totalCost.toFixed(4)}`);
    return { spec, created: false, totalCost, dryRun: true };
  }

  if (!yes) {
    const ok = await _promptConfirmFn("Create this agent?");
    if (!ok) {
      console.log("Aborted.");
      return { spec, created: false, totalCost, aborted: true };
    }
  }

  // Build createAgent opts from spec
  await createAgent({
    name: spec.name,
    template: spec.template,
    mission: spec.mission,
    model: spec.model || "sonnet",
    maxTurns: spec.maxTurns,
    workdir: spec.workdir || undefined,
    outputFile: spec.outputFile || null,
    createdBy: "describe",
  });

  // Bootstrap loop
  let bootstrap = null;
  if (!noBootstrap) {
    const remaining = Math.max(0, costBudget - totalCost);
    if (remaining <= 0) {
      console.log(`\n[bootstrap] Skipped: budget exhausted by parse step.`);
    } else {
      console.log(`\nBootstrapping harness (max ${maxIterations} iter, budget $${remaining.toFixed(2)})...`);
      bootstrap = await bootstrapAgent(spec.name, {
        maxIterations,
        costBudget: remaining,
      });
      totalCost += bootstrap.cost;
      console.log(
        `  Bootstrap: ${bootstrap.iterations} iter, domain_encoding=${bootstrap.finalScore ?? "?"}, stopped=${bootstrap.stopped}, cost=$${bootstrap.cost.toFixed(4)}`,
      );
    }
  }

  // Schedule
  let scheduled = null;
  if (!noSchedule && spec.schedule) {
    const cronExpr = spec.schedule.cron
      ? spec.schedule.cron
      : expandScheduleSugar(spec.schedule.at);
    try {
      await scheduleInstall(spec.name, cronExpr, { force: false });
      scheduled = { cron: cronExpr };
    } catch (err) {
      console.error(`[schedule] Install failed: ${err.message}`);
    }
  } else if (!noSchedule && !spec.schedule) {
    console.log(`\n[schedule] No schedule in spec — agent will only run on-demand.`);
  }

  // Final summary
  console.log(`\n--- Summary ---`);
  console.log(`Created agent "${spec.name}"`);
  console.log(`  Mission:    ${spec.mission}`);
  if (spec.workdir) console.log(`  Workdir:    ${spec.workdir}`);
  if (scheduled) console.log(`  Schedule:   ${scheduled.cron}`);
  if (bootstrap) {
    console.log(`  Bootstrap:  ${bootstrap.iterations} iter, domain_encoding=${bootstrap.finalScore ?? "?"}, stopped=${bootstrap.stopped}`);
  }
  console.log(`  Cost:       $${totalCost.toFixed(4)} / $${costBudget.toFixed(2)} budget`);
  console.log(`  Run now:    node orchestrator.mjs run ${spec.name}`);
  console.log(`  View:       node orchestrator.mjs status ${spec.name}`);

  return {
    spec,
    created: true,
    totalCost,
    bootstrap,
    scheduled,
  };
}

// List agents that were created by `describe` (config.createdBy === "describe").
export async function describeList() {
  if (!(await exists(_agentsDir))) {
    console.log("No agents found.");
    return;
  }
  const entries = await readdir(_agentsDir, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = join(_agentsDir, entry.name, "config.json");
    try {
      const config = await readJson(configPath);
      if (config.createdBy !== "describe") continue;
      const sched = config.schedule || {};
      const schedStr = sched.cron
        ? sched.cron
        : sched.intervalSeconds
          ? `every ${sched.intervalSeconds}s`
          : "-";
      rows.push({
        name: entry.name,
        mission: config.mission || "",
        workdir: config.workdir || "-",
        schedule: schedStr,
        created: config.created || "-",
      });
    } catch {
      // skip unreadable
    }
  }

  if (rows.length === 0) {
    console.log('No describe-generated agents. Create one with: orchestrator describe "<description>"');
    return;
  }

  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const header = `${"NAME".padEnd(22)} ${"MISSION".padEnd(50)} ${"WORKDIR".padEnd(24)} ${"SCHEDULE".padEnd(16)} CREATED`;
  console.log(header);
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(22)} ${truncate(r.mission, 50).padEnd(50)} ${truncate(r.workdir, 24).padEnd(24)} ${r.schedule.padEnd(16)} ${r.created}`,
    );
  }
}

// --- Run ---

export function computeBackoffMs(consecutiveErrors) {
  if (consecutiveErrors <= 0) return 0;
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, consecutiveErrors - 1), MAX_BACKOFF_MS);
}

export function classifyFailure(stderr, stdout) {
  const text = (stderr + stdout).toLowerCase();
  if (
    text.includes("401") ||
    text.includes("unauthorized") ||
    text.includes("authentication") ||
    text.includes("invalid api key") ||
    text.includes("invalid_api_key")
  ) {
    return "auth_error";
  }
  if (
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("overloaded") ||
    text.includes("too many requests") ||
    text.includes("503") ||
    text.includes("529")
  ) {
    return "transient";
  }
  return "transient";
}

export function updateCostAccumulators(state, costUsd) {
  if (costUsd == null || typeof costUsd !== "number") return;
  const today = new Date().toLocaleDateString("en-CA"); // local timezone, YYYY-MM-DD
  if (!state.dailyCost || state.dailyCost.date !== today) {
    state.dailyCost = { date: today, totalUsd: 0 };
  }
  state.dailyCost.totalUsd = (state.dailyCost.totalUsd || 0) + costUsd;
  state.lifetimeCostUsd = (state.lifetimeCostUsd || 0) + costUsd;
}

export async function recoverStaleAgents(agents, writeJsonFn = writeJson) {
  for (const agent of agents) {
    if (agent.state.status !== "running") continue;

    const pid = agent.state.runningPid;
    const lockExpiry = agent.state.lockExpiry
      ? new Date(agent.state.lockExpiry).getTime()
      : 0;

    let isAlive = false;
    if (pid) {
      try {
        process.kill(pid, 0);
        isAlive = true;
      } catch (e) {
        isAlive = e.code === "EPERM"; // ESRCH = dead; EPERM = alive but no permission
      }
    }

    // Primary gate: if lock has expired, it's stale regardless of PID
    if (isAlive && Date.now() < lockExpiry) continue;

    agent.state.status = "error";
    agent.state.lastError = "stale_lock_recovered";
    agent.state.runningPid = null;
    agent.state.lockExpiry = null;
    await writeJsonFn(join(_agentsDir, agent.name, "state.json"), agent.state);
    console.log(`[recover] stale_lock_recovered: agent "${agent.name}" (was PID ${pid ?? "unknown"})`);
  }
}

export function buildFreshPrompt(config, agentDir, runDir, message) {
  return [
    `You are agent "${config.name}".`,
    `Read your CLAUDE.md at ${join(agentDir, "CLAUDE.md")} for your full identity, mission, and operating rules.`,
    config.workdir ? `Your primary workspace is: ${config.workdir} — navigate there to do your work.` : "",
    config.workdir ? `Read ${config.workdir}/CLAUDE.md if it exists for project-specific conventions.` : "",
    `Your agent directory (memory, state): ${agentDir}`,
    `Save run outputs to: ${runDir}/`,
    `You have ${config.maxTurns} turns total. Use them to complete your mission fully.`,
    `Write your key outputs to ${runDir}/ before stopping.`,
    `Current date: ${new Date().toISOString()}`,
    message ? `\nTask: ${message}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildResumePrompt(config, runDir, resumeMessage) {
  const base = resumeMessage || "Continue your work from where you left off. Check your memory and previous output.";
  return [
    base,
    `Save run outputs to: ${runDir}/`,
    `You have ${config.maxTurns} turns total. Use them wisely.`,
    `Current date: ${new Date().toISOString()}`,
  ].join("\n");
}

function spawnClaude(args, { cwd, timeout = AGENT_TIMEOUT, onPid, env } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      env: env ? { ...process.env, ...env } : undefined,
    });
    if (onPid) onPid(proc.pid);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("close", (code) => resolve({ code, stdout, stderr }));
    proc.on("error", (err) => resolve({ code: 1, stdout: "", stderr: err.message }));
  });
}

// Test injection points — allow tests to mock without real Claude invocations
let _spawnClaudeFn = spawnClaude;
export function _testSetSpawnClaude(fn) { _spawnClaudeFn = fn; }
export function _testResetSpawnClaude() { _spawnClaudeFn = spawnClaude; }

// Scheduling — injectable exec for OS-touching calls (launchctl, crontab, plutil)
const _execPromise = promisify(exec);
let _execFn = _execPromise;
export function _testSetExec(fn) { _execFn = fn; }
export function _testResetExec() { _execFn = _execPromise; }

let _agentsDir = AGENTS_DIR;
let _pipelinesDir = PIPELINES_DIR;
export function _testSetDirs({ agents, pipelines, launchAgents } = {}) {
  if (agents) _agentsDir = agents;
  if (pipelines) _pipelinesDir = pipelines;
  if (launchAgents) LAUNCH_AGENTS_DIR = launchAgents;
}
export function _testResetDirs() {
  _agentsDir = AGENTS_DIR;
  _pipelinesDir = PIPELINES_DIR;
  LAUNCH_AGENTS_DIR = DEFAULT_LAUNCH_AGENTS_DIR;
}

function parseClaudeOutput(stdout) {
  try {
    const result = JSON.parse(stdout);
    return {
      sessionId: result.session_id ?? null,
      costUsd: result.total_cost_usd ?? result.cost_usd ?? null,
      durationMs: result.duration_ms ?? null,
      turns: result.num_turns ?? null,
      subtype: result.subtype ?? null,
      result: result.result ?? null,
    };
  } catch {
    return { sessionId: null, costUsd: null, durationMs: null, turns: null, subtype: null, result: null };
  }
}

async function runAgent(name, { verbose = false, message = null, fresh = false, outputFile: outputFileOverride = null, suppressEval = false } = {}) {
  const agentDir = join(_agentsDir, name);
  if (!(await exists(agentDir))) throw new Error(`Agent "${name}" not found`);

  const config = await readAgentConfig(agentDir);
  const state = await readJson(join(agentDir, "state.json"));

  if (state.status === "running") {
    console.log(`Agent "${name}" is already running — skipping`);
    return state;
  }

  const runTs = ts();
  const runDir = join(agentDir, "runs", runTs);
  const outputFile = outputFileOverride || (config.outputFile ? join(runDir, config.outputFile) : null);
  await mkdir(runDir, { recursive: true });

  // Decide: resume existing session or start fresh
  const canResume = !fresh && state.sessionId && !message;
  const isResume = canResume && state.lastRun &&
    (Date.now() - new Date(state.lastRun).getTime()) < 3600_000; // <1h old

  // Mark running
  state.status = "running";
  state.lastRun = iso();
  await writeJson(join(agentDir, "state.json"), state);

  const cwd = agentDir;

  let args;

  if (isResume) {
    // Resume previous session
    const resumePrompt = buildResumePrompt(config, runDir, message);
    args = [
      "--dangerously-skip-permissions",
      "--max-turns", String(config.maxTurns),
      "--output-format", "json",
      "--model", config.model,
      "--resume", state.sessionId,
      "-p", resumePrompt,
    ];
    if (verbose) console.log(`Resuming agent "${name}" (session: ${state.sessionId.slice(0, 12)}...)`);
  } else if (message && state.sessionId && !fresh) {
    // Continue session with new message (multi-turn steering)
    const continuePrompt = buildResumePrompt(config, runDir, message);
    args = [
      "--dangerously-skip-permissions",
      "--max-turns", String(config.maxTurns),
      "--output-format", "json",
      "--model", config.model,
      "--resume", state.sessionId,
      "-p", continuePrompt,
    ];
    if (verbose) console.log(`Continuing agent "${name}" with message (session: ${state.sessionId.slice(0, 12)}...)`);
  } else {
    // Fresh session
    const prompt = buildFreshPrompt(config, agentDir, runDir, message);
    args = [
      "--dangerously-skip-permissions",
      "--max-turns", String(config.maxTurns),
      "--output-format", "json",
      "--model", config.model,
      "-p", prompt,
    ];
    if (verbose) {
      console.log(`Spawning agent "${name}" (model: ${config.model}, max turns: ${config.maxTurns}, fresh session)`);
      if (config.workdir) console.log(`  Workdir: ${config.workdir}`);
    }
  }

  const agentTimeout = config.timeoutMs ?? AGENT_TIMEOUT;
  const lockExpiry = new Date(Date.now() + agentTimeout).toISOString();
  const spawnEnv = {
    ...(outputFile ? { AGENT_OUTPUT_FILE: outputFile } : {}),
    AGENT_RUN_DIR: runDir,
  };
  const { code, stdout, stderr } = await _spawnClaudeFn(args, {
    cwd,
    timeout: agentTimeout,
    onPid: async (pid) => {
      state.runningPid = pid;
      state.lockExpiry = lockExpiry;
      await writeJson(join(agentDir, "state.json"), state);
    },
    env: spawnEnv,
  });

  // Update state
  if (code === 0) {
    state.status = "idle";
    state.consecutiveErrors = 0;
    state.nextRetryAfter = null;
  } else {
    const failureType = classifyFailure(stderr, stdout);
    if (failureType === "auth_error") {
      state.status = "auth_error";
      state.nextRetryAfter = null;
      console.log(`[${iso()}] Agent "${name}" auth_error — permanently skipped until manual reset`);
    } else {
      state.status = "error";
      state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
      const backoff = computeBackoffMs(state.consecutiveErrors);
      state.nextRetryAfter = backoff > 0
        ? new Date(Date.now() + backoff).toISOString()
        : null;
      console.log(`[${iso()}] Agent "${name}" error (consecutive: ${state.consecutiveErrors}, retry after: ${state.nextRetryAfter ?? "now"})`);
    }
  }
  state.runCount++;
  state.runningPid = null;
  state.lockExpiry = null;

  const parsed = parseClaudeOutput(stdout);

  // Accumulate cost and enforce daily budget (COST-01/02/03)
  updateCostAccumulators(state, parsed.costUsd);
  if (
    state.status === "idle" &&
    config.maxDailyCostUsd != null &&
    state.dailyCost != null &&
    state.dailyCost.totalUsd >= config.maxDailyCostUsd
  ) {
    state.status = "budget_exceeded";
    console.log(
      `[${iso()}] Agent "${name}" budget_exceeded: daily $${state.dailyCost.totalUsd.toFixed(4)} >= limit $${config.maxDailyCostUsd}`,
    );
  }

  // Track session for resume
  if (parsed.sessionId) {
    state.sessionId = parsed.sessionId;
    state.sessionStarted = state.sessionStarted || iso();
  }

  state.lastResult = {
    exitCode: code,
    costUsd: parsed.costUsd,
    durationMs: parsed.durationMs,
    turns: parsed.turns,
    timestamp: runTs,
    resumed: isResume || (message && !fresh && !!state.sessionId),
  };

  state.lastError = code !== 0 ? stderr.slice(0, 1000) : null;

  await writeJson(join(agentDir, "state.json"), state);
  await writeFile(join(runDir, "output.json"), stdout || "{}");
  if (stderr) await writeFile(join(runDir, "stderr.txt"), stderr);

  const status = code === 0 ? "completed" : "failed";
  console.log(`Agent "${name}" ${status} (exit ${code}, run #${state.runCount})`);
  if (parsed.sessionId) console.log(`  Session: ${parsed.sessionId}`);
  if (parsed.costUsd) console.log(`  Cost: $${parsed.costUsd.toFixed(4)}`);
  if (parsed.durationMs) console.log(`  Duration: ${(parsed.durationMs / 1000).toFixed(1)}s`);

  // Auto-eval every N runs (suppressed for pipeline workers per COEX-02)
  if (code === 0 && state.runCount % EVAL_EVERY_N_RUNS === 0 && !suppressEval) {
    console.log(`  Auto-eval triggered (every ${EVAL_EVERY_N_RUNS} runs)`);
    evalAgent(name, { runTimestamp: runTs }).catch((err) =>
      console.error(`  Auto-eval error: ${err.message}`),
    );
  }

  // Auto-continue: if agent ran out of turns and config allows it, resume the session
  if (
    parsed.subtype === "error_max_turns" &&
    parsed.sessionId &&
    config.autoContinue?.enabled
  ) {
    const maxCont = config.autoContinue.maxContinuations ?? 2;
    const contCount = state.autoContinueCount ?? 0;

    if (contCount < maxCont) {
      state.autoContinueCount = contCount + 1;
      state.status = "idle"; // reset so runAgent accepts it
      await writeJson(join(agentDir, "state.json"), state);

      console.log(`  Auto-continue ${contCount + 1}/${maxCont} — agent ran out of turns, resuming session...`);

      const contMsg = [
        `You ran out of turns on your previous chunk (continuation ${contCount + 1}/${maxCont}).`,
        `You have ${config.maxTurns} more turns. Pick up where you left off.`,
        `If you wrote a continuation plan, follow it. Otherwise check your memory and output directory.`,
        `IMPORTANT: Prioritize finishing the report before testing more pages.`,
      ].join("\n");

      return runAgent(name, { verbose, message: contMsg });
    } else {
      console.log(`  Auto-continue limit reached (${maxCont}/${maxCont}) — stopping.`);
      state.autoContinueCount = 0;
      await writeJson(join(agentDir, "state.json"), state);
    }
  } else if (parsed.subtype !== "error_max_turns") {
    // Reset continuation counter on normal completion
    if (state.autoContinueCount) {
      state.autoContinueCount = 0;
      await writeJson(join(agentDir, "state.json"), state);
    }
  }

  return state;
}

// --- List ---

async function listAgents() {
  const agents = await loadAgents();
  if (agents.length === 0) {
    console.log(
      'No agents yet. Create one with:\n  node orchestrator.mjs create --name <name> --mission "<mission>"',
    );
    return;
  }

  console.log(
    `\n${pad("Name", 22)} ${pad("Status", 14)} ${pad("Runs", 6)} ${pad("Eval", 6)} ${pad("Last Run", 22)} ${pad("Template", 12)} ${pad("Model", 8)} ${pad("Daily$", 10)} ${pad("Total$", 10)} Schedule`,
  );
  console.log("-".repeat(130));

  for (const a of agents) {
    const lastRun = a.state.lastRun
      ? new Date(a.state.lastRun).toLocaleString()
      : "never";
    const schedule = a.config.schedule
      ? `every ${a.config.schedule.intervalSeconds}s`
      : "-";
    const evalScore = a.state.evalAverage != null
      ? `${a.state.evalAverage}`
      : a.state.lastEval
        ? `${a.state.lastEval.overall}`
        : "-";
    const dailyCost = a.state.dailyCost?.totalUsd != null
      ? `$${a.state.dailyCost.totalUsd.toFixed(4)}`
      : "-";
    const lifetimeCost = a.state.lifetimeCostUsd != null
      ? `$${a.state.lifetimeCostUsd.toFixed(4)}`
      : "-";
    console.log(
      `${pad(a.name, 22)} ${pad(a.state.status, 14)} ${pad(a.state.runCount, 6)} ${pad(evalScore, 6)} ${pad(lastRun, 22)} ${pad(a.config.template, 12)} ${pad(a.config.model, 8)} ${pad(dailyCost, 10)} ${pad(lifetimeCost, 10)} ${schedule}`,
    );
  }
  console.log();
}

// --- Status ---

async function showStatus(name) {
  const agentDir = join(_agentsDir, name);
  if (!(await exists(agentDir))) throw new Error(`Agent "${name}" not found`);

  const config = await readAgentConfig(agentDir);
  const state = await readJson(join(agentDir, "state.json"));

  console.log(`\nAgent: ${config.name}`);
  console.log(`  Mission:  ${config.mission}`);
  console.log(`  Template: ${config.template}`);
  console.log(`  Model:    ${config.model}`);
  console.log(`  Turns:    ${config.maxTurns}`);
  console.log(
    `  Schedule: ${config.schedule ? `every ${config.schedule.intervalSeconds}s` : "manual"}`,
  );
  console.log(`  Workdir:  ${config.workdir || "(agent dir)"}`);
  console.log(`  Created:  ${config.created}`);
  console.log(`  Status:   ${state.status}`);
  console.log(`  Session:  ${state.sessionId ? state.sessionId.slice(0, 16) + "..." : "none"}`);
  console.log(`  Runs:     ${state.runCount}`);
  console.log(
    `  Last run: ${state.lastRun ? new Date(state.lastRun).toLocaleString() : "never"}`,
  );

  if (state.lastResult) {
    console.log(`  Last result:`);
    if (state.lastResult.costUsd != null)
      console.log(`    Cost:     $${state.lastResult.costUsd.toFixed(4)}`);
    if (state.lastResult.durationMs != null)
      console.log(
        `    Duration: ${(state.lastResult.durationMs / 1000).toFixed(1)}s`,
      );
    if (state.lastResult.turns != null)
      console.log(`    Turns:    ${state.lastResult.turns}`);
    console.log(`    Exit:     ${state.lastResult.exitCode}`);
  }

  // File activity from latest run
  if (state.lastResult?.timestamp) {
    const activityFile = join(agentDir, "runs", state.lastResult.timestamp, "activity.jsonl");
    try {
      const raw = await readFile(activityFile, "utf8");
      const lines = raw.trim().split("\n").filter(Boolean).slice(0, 200);
      const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const writes = [...new Set(entries.filter(e => e.action === "write").map(e => e.file))];
      if (writes.length > 0) {
        console.log(`  Files written: ${writes.length}`);
        for (const f of writes.slice(0, 10)) console.log(`    W: ${f}`);
        if (writes.length > 10) console.log(`    ... and ${writes.length - 10} more`);
      }
    } catch {}
  }

  if (state.lastError) {
    console.log(`  Last error: ${state.lastError.slice(0, 200)}`);
  }

  // Cost tracking
  if (state.dailyCost) {
    console.log(`  Daily cost:   $${state.dailyCost.totalUsd.toFixed(4)} (${state.dailyCost.date})`);
  }
  if (state.lifetimeCostUsd != null) {
    console.log(`  Lifetime:     $${state.lifetimeCostUsd.toFixed(4)}`);
  }
  if (config.maxDailyCostUsd != null) {
    console.log(`  Daily limit:  $${config.maxDailyCostUsd}`);
  }

  // Eval scores
  if (state.lastEval) {
    console.log(`  Last eval:  ${state.lastEval.overall}/10 (run: ${state.lastEval.runTimestamp})`);
    const s = state.lastEval.scores;
    console.log(`    Mission: ${s.mission_completion}  Quality: ${s.output_quality}  Verify: ${s.verification_compliance}  Efficiency: ${s.turn_efficiency}  Memory: ${s.memory_hygiene}`);
  }
  if (state.evalAverage != null) {
    console.log(`  Eval avg:   ${state.evalAverage}/10 (${state.evalHistory.length} eval(s))`);
  }
  if (state.lastAudit) {
    console.log(`  Audit:      ${state.lastAudit.overall}/10 (${new Date(state.lastAudit.auditedAt).toLocaleString()})`);
    console.log(`  Verdict:    ${state.lastAudit.verdict}`);
  }

  // Count runs
  const runsDir = join(agentDir, "runs");
  if (await exists(runsDir)) {
    const runs = await readdir(runsDir);
    console.log(`  Run history: ${runs.length} run(s) in ${runsDir}`);
  }
  console.log();
}

// --- Dashboard ---

async function showDashboard() {
  const agents = await loadAgents();

  if (agents.length === 0) {
    console.log("No agents found.");
    return;
  }

  const today = new Date().toLocaleDateString("en-CA");
  let running = 0, idle = 0, errored = 0;
  let todayRuns = 0, todayCost = 0;
  const evalScores = [];

  for (const agent of agents) {
    const s = agent.state;
    if (s.status === "running") running++;
    else if (s.status === "idle" || s.status === "budget_exceeded") idle++;
    else errored++;

    if (s.dailyCost?.date === today) {
      todayCost += s.dailyCost.totalUsd || 0;
    }
    todayRuns += s.runCount || 0; // lifetime total, not daily

    if (s.evalAverage != null) {
      evalScores.push({ name: agent.name, score: s.evalAverage });
    }
  }

  const avgEval = evalScores.length > 0
    ? (evalScores.reduce((s, e) => s + e.score, 0) / evalScores.length).toFixed(1)
    : "n/a";

  console.log(`\nAgent Orchestrator Dashboard`);
  console.log(`=============================`);
  console.log(`Agents: ${agents.length} total | ${running} running | ${idle} idle | ${errored} error`);
  console.log(`Runs:   ${todayRuns} lifetime | $${todayCost.toFixed(2)} cost today | ${avgEval}/10 avg eval`);

  // Running now
  const runningAgents = agents.filter(a => a.state.status === "running");
  if (runningAgents.length > 0) {
    console.log(`\nRunning Now:`);
    for (const a of runningAgents) {
      const cost = a.state.lastResult?.costUsd ? `$${a.state.lastResult.costUsd.toFixed(2)}` : "";
      console.log(`  ${pad(a.name, 30)} run #${a.state.runCount || "?"}  ${cost}`);
    }
  }

  // Top by eval
  if (evalScores.length > 0) {
    evalScores.sort((a, b) => b.score - a.score);
    console.log(`\nTop by Eval:`);
    for (const e of evalScores.slice(0, 5)) {
      console.log(`  ${pad(e.name, 30)} ${e.score}/10`);
    }
  }

  // Cost leaders today
  const costLeaders = agents
    .filter(a => a.state.dailyCost?.date === today && a.state.dailyCost.totalUsd > 0)
    .sort((a, b) => (b.state.dailyCost.totalUsd || 0) - (a.state.dailyCost.totalUsd || 0));
  if (costLeaders.length > 0) {
    console.log(`\nCost Leaders (Today):`);
    for (const a of costLeaders.slice(0, 5)) {
      console.log(`  ${pad(a.name, 30)} $${a.state.dailyCost.totalUsd.toFixed(2)}`);
    }
  }

  // Autoresearch active
  const arAgents = agents.filter(a => a.state.autoresearch);
  if (arAgents.length > 0) {
    console.log(`\nAutoresearch:`);
    for (const a of arAgents) {
      const ar = a.state.autoresearch;
      console.log(`  ${pad(a.name, 30)} ${ar.baselineScore} → ${ar.currentScore}  (${ar.improvements} improvements, $${ar.totalCostUsd.toFixed(2)})`);
    }
  }

  console.log();
}

// --- Logs ---

async function showLogs(name) {
  const agentDir = join(_agentsDir, name);
  if (!(await exists(agentDir))) throw new Error(`Agent "${name}" not found`);

  const runsDir = join(agentDir, "runs");
  if (!(await exists(runsDir))) {
    console.log("No runs yet.");
    return;
  }

  const runs = (await readdir(runsDir)).sort().reverse();
  if (runs.length === 0) {
    console.log("No runs yet.");
    return;
  }

  const latestRun = runs[0];
  console.log(`\n--- Latest run: ${latestRun} ---\n`);

  const outputPath = join(runsDir, latestRun, "output.json");
  if (await exists(outputPath)) {
    try {
      const output = JSON.parse(await readFile(outputPath, "utf8"));
      if (output.result) {
        console.log(output.result);
      } else {
        // Show a summary of the JSON output
        const summary = {
          cost_usd: output.cost_usd,
          duration_ms: output.duration_ms,
          num_turns: output.num_turns,
          result_preview: output.result
            ? output.result.slice(0, 500)
            : "(no result field)",
        };
        console.log(JSON.stringify(summary, null, 2));
      }
    } catch {
      const raw = await readFile(outputPath, "utf8");
      console.log(raw.slice(0, 3000));
    }
  }

  const stderrPath = join(runsDir, latestRun, "stderr.txt");
  if (await exists(stderrPath)) {
    console.log(`\n--- stderr ---\n`);
    const stderr = await readFile(stderrPath, "utf8");
    console.log(stderr.slice(0, 2000));
  }

  if (runs.length > 1) {
    console.log(`\n--- Previous runs: ${runs.slice(1, 6).join(", ")} ---`);
  }
}

// --- Autoresearch Helpers ---

export function computeClaudeMdHash(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

export async function revertClaudeMd(agentDir) {
  const memoryDir = join(agentDir, ".claude", "memory");
  if (!(await exists(memoryDir))) return false;
  const entries = (await readdir(memoryDir)).filter(f => f.startsWith("CLAUDE.md.bak-")).sort().reverse();
  if (entries.length === 0) return false;
  const latestBackup = join(memoryDir, entries[0]);
  const claudeMdPath = join(agentDir, "CLAUDE.md");
  await copyFile(latestBackup, claudeMdPath);
  return true;
}

export async function writeExperimentLog(agentDir, entry) {
  const expDir = join(agentDir, "experiments");
  await mkdir(expDir, { recursive: true });
  const logPath = join(expDir, "autoresearch.jsonl");
  await appendFile(logPath, JSON.stringify(entry) + "\n");
}

// --- Eval ---

export async function evalAgent(name, { runTimestamp = null, verbose = false } = {}) {
  const agentDir = join(_agentsDir, name);
  if (!(await exists(agentDir))) throw new Error(`Agent "${name}" not found`);

  const config = await readAgentConfig(agentDir);
  const state = await readJson(join(agentDir, "state.json"));
  const claudeMd = await readFile(join(agentDir, "CLAUDE.md"), "utf8");

  // Find the run to evaluate
  const runsDir = join(agentDir, "runs");
  if (!(await exists(runsDir))) throw new Error("No runs to evaluate");
  const runs = (await readdir(runsDir)).sort().reverse();
  if (runs.length === 0) throw new Error("No runs to evaluate");

  const targetRun = runTimestamp || runs[0];
  const runDir = join(runsDir, targetRun);
  if (!(await exists(runDir)))
    throw new Error(`Run "${targetRun}" not found`);

  // Check if already evaluated
  const evalPath = join(runDir, "eval.json");
  if (await exists(evalPath)) {
    if (verbose) console.log(`Run "${targetRun}" already evaluated — re-evaluating`);
  }

  // Read output
  let output = "";
  const outputPath = join(runDir, "output.json");
  if (await exists(outputPath)) {
    try {
      const parsed = JSON.parse(await readFile(outputPath, "utf8"));
      output = parsed.result || JSON.stringify(parsed, null, 2).slice(0, 8000);
    } catch {
      output = (await readFile(outputPath, "utf8")).slice(0, 8000);
    }
  }

  // Also read any report.md the agent may have produced
  const reportPath = join(runDir, "report.md");
  if (await exists(reportPath)) {
    const report = await readFile(reportPath, "utf8");
    output += "\n\n--- report.md ---\n" + report.slice(0, 8000);
  }

  if (!output || output.length < 10) {
    console.log(`Run "${targetRun}" has no meaningful output to evaluate`);
    return null;
  }

  // Build judge prompt from template
  let judgePrompt = await readFile(JUDGE_TEMPLATE, "utf8");
  judgePrompt = judgePrompt
    .replaceAll("{{AGENT_NAME}}", config.name)
    .replaceAll("{{MISSION}}", config.mission)
    .replaceAll("{{TEMPLATE}}", config.template)
    .replaceAll("{{CLAUDE_MD}}", claudeMd.slice(0, 4000))
    .replaceAll("{{OUTPUT}}", output.slice(0, 12000));

  if (verbose) console.log(`Evaluating run "${targetRun}" for agent "${name}"...`);

  const args = [
    "--dangerously-skip-permissions",
    "--max-turns",
    String(JUDGE_MAX_TURNS),
    "--output-format",
    "json",
    "--model",
    JUDGE_MODEL,
    "-p",
    judgePrompt,
  ];

  let evalResult = null;
  try {
    const { code, stdout, stderr } = await _spawnClaudeFn(args, { cwd: agentDir, timeout: 5 * 60 * 1000 });

    if (code === 0) {
      try {
        const claudeOutput = JSON.parse(stdout);
        const resultText = claudeOutput.result || stdout;
        const jsonMatch = resultText.match(/\{[\s\S]*"scores"[\s\S]*\}/);
        if (jsonMatch) evalResult = JSON.parse(jsonMatch[0]);
      } catch {
        try {
          const jsonMatch = stdout.match(/\{[\s\S]*"scores"[\s\S]*\}/);
          if (jsonMatch) evalResult = JSON.parse(jsonMatch[0]);
        } catch {}
      }
    }

    if (evalResult) {
      evalResult.evaluatedAt = iso();
      evalResult.runTimestamp = targetRun;
      try { const parsed = JSON.parse(stdout); evalResult.costUsd = parsed.total_cost_usd ?? null; } catch {}
      await writeJson(evalPath, evalResult);

      state.lastEval = {
        overall: evalResult.overall,
        scores: evalResult.scores,
        runTimestamp: targetRun,
        evaluatedAt: evalResult.evaluatedAt,
      };

      if (!state.evalHistory) state.evalHistory = [];
      state.evalHistory.unshift({ overall: evalResult.overall, runTimestamp: targetRun });
      state.evalHistory = state.evalHistory.slice(0, 10);

      state.evalAverage = Math.round(
        (state.evalHistory.reduce((s, e) => s + e.overall, 0) / state.evalHistory.length) * 10
      ) / 10;

      await writeJson(join(agentDir, "state.json"), state);

      console.log(`\nEval for "${name}" (run: ${targetRun}):`);
      console.log(`  Overall:      ${evalResult.overall}/10`);
      console.log(`  Mission:      ${evalResult.scores.mission_completion}/10`);
      console.log(`  Quality:      ${evalResult.scores.output_quality}/10`);
      console.log(`  Verification: ${evalResult.scores.verification_compliance}/10`);
      console.log(`  Efficiency:   ${evalResult.scores.turn_efficiency}/10`);
      console.log(`  Memory:       ${evalResult.scores.memory_hygiene}/10`);
      if (evalResult.strengths?.length) console.log(`  Strengths:    ${evalResult.strengths.join(", ")}`);
      if (evalResult.weaknesses?.length) console.log(`  Weaknesses:   ${evalResult.weaknesses.join(", ")}`);
      if (state.evalHistory.length > 1) console.log(`  Avg (${state.evalHistory.length} evals): ${state.evalAverage}/10`);
    } else {
      console.error(`Eval failed for "${name}" (exit ${code})`);
      if (stderr) console.error(`  ${stderr.slice(0, 300)}`);
    }
  } catch (err) {
    console.error(`Eval spawn error: ${err.message}`);
  }

  return evalResult;
}

// --- Audit ---

export async function auditAgent(name) {
  const agentDir = join(_agentsDir, name);
  if (!(await exists(agentDir))) throw new Error(`Agent "${name}" not found`);

  const config = await readAgentConfig(agentDir);
  const state = await readJson(join(agentDir, "state.json"));
  const claudeMd = await readFile(join(agentDir, "CLAUDE.md"), "utf8");

  // Build eval history summary
  let evalHistory = "No evaluations yet.";
  if (state.evalHistory?.length) {
    const lines = state.evalHistory.map(
      (e) => `  Run ${e.runTimestamp}: ${e.overall}/10`,
    );
    evalHistory = `${state.evalHistory.length} eval(s), average: ${state.evalAverage}/10\n${lines.join("\n")}`;
  }

  // Build audit prompt
  let auditPrompt = await readFile(AUDIT_TEMPLATE, "utf8");
  auditPrompt = auditPrompt
    .replaceAll("{{AGENT_NAME}}", config.name)
    .replaceAll("{{MISSION}}", config.mission)
    .replaceAll("{{TEMPLATE}}", config.template)
    .replaceAll("{{MODEL}}", config.model)
    .replaceAll("{{MAX_TURNS}}", String(config.maxTurns))
    .replaceAll("{{WORKDIR}}", config.workdir || "(agent dir)")
    .replaceAll("{{CLAUDE_MD}}", claudeMd)
    .replaceAll("{{EVAL_HISTORY}}", evalHistory);

  console.log(`Auditing harness for agent "${name}"...`);

  const args = [
    "--dangerously-skip-permissions",
    "--max-turns",
    String(JUDGE_MAX_TURNS),
    "--output-format",
    "json",
    "--model",
    JUDGE_MODEL,
    "-p",
    auditPrompt,
  ];

  let auditResult = null;
  try {
    const { code, stdout, stderr } = await _spawnClaudeFn(args, { cwd: agentDir, timeout: 5 * 60 * 1000 });

    if (code === 0) {
      try {
        const claudeOutput = JSON.parse(stdout);
        const resultText = claudeOutput.result || stdout;
        const jsonMatch = resultText.match(/\{[\s\S]*"scores"[\s\S]*\}/);
        if (jsonMatch) auditResult = JSON.parse(jsonMatch[0]);
      } catch {
        try {
          const jsonMatch = stdout.match(/\{[\s\S]*"scores"[\s\S]*\}/);
          if (jsonMatch) auditResult = JSON.parse(jsonMatch[0]);
        } catch {}
      }
    }

    if (auditResult) {
      auditResult.auditedAt = iso();
      try { const parsed = JSON.parse(stdout); auditResult.costUsd = parsed.total_cost_usd ?? null; } catch {}
      await writeJson(join(agentDir, "audit.json"), auditResult);

      state.lastAudit = {
        overall: auditResult.overall,
        scores: auditResult.scores,
        auditedAt: auditResult.auditedAt,
        verdict: auditResult.verdict,
      };
      await writeJson(join(agentDir, "state.json"), state);

      console.log(`\nAudit for "${name}":`);
      console.log(`  Overall:        ${auditResult.overall}/10`);
      const s = auditResult.scores;
      console.log(`  Mission:        ${s.mission_clarity}/10`);
      console.log(`  Instructions:   ${s.instruction_quality}/10`);
      console.log(`  Verification:   ${s.verification_design}/10`);
      console.log(`  Turn budget:    ${s.turn_budget_fit}/10`);
      console.log(`  Memory:         ${s.memory_protocol}/10`);
      console.log(`  Domain:         ${s.domain_encoding}/10`);

      if (auditResult.critical_issues?.length) {
        console.log(`\n  Critical issues:`);
        for (const issue of auditResult.critical_issues) console.log(`    - ${issue}`);
      }
      if (auditResult.improvements?.length) {
        console.log(`\n  Suggested improvements:`);
        for (const imp of auditResult.improvements) {
          console.log(`    [${imp.section}] ${imp.reason}`);
          console.log(`      Current:   ${imp.current.slice(0, 80)}`);
          console.log(`      Suggested: ${imp.suggested.slice(0, 80)}`);
        }
      }
      console.log(`\n  Verdict: ${auditResult.verdict}`);
    } else {
      console.error(`Audit failed (exit ${code})`);
      if (stderr) console.error(`  ${stderr.slice(0, 300)}`);
    }
  } catch (err) {
    console.error(`Audit spawn error: ${err.message}`);
  }

  return auditResult;
}

// --- Improve ---

export function applyAuditImprovements(claudeMd, improvements) {
  return improvements.map((imp) => ({
    section: imp.section,
    current: imp.current,
    suggested: imp.suggested,
    reason: imp.reason,
    found: claudeMd.includes(imp.current),
  }));
}

export function buildChangelogEntry(appliedSections, date) {
  const lines = appliedSections.map((s) => `- ${s}`).join("\n");
  return `\n\n---\n## Improve History\n\n### ${date} — improve applied\n${lines}\n`;
}

export async function improveAgent(name, { apply = false } = {}) {
  const agentDir = join(_agentsDir, name);
  if (!(await exists(agentDir))) throw new Error(`Agent "${name}" not found`);

  const auditPath = join(agentDir, "audit.json");
  if (!(await exists(auditPath))) {
    throw new Error(`No audit.json for "${name}". Run 'audit ${name}' first.`);
  }

  const audit = await readJson(auditPath);
  const improvements = audit.improvements || [];
  if (improvements.length === 0) {
    console.log(`No improvements in audit.json for "${name}".`);
    return { applied: 0, skipped: 0, total: 0 };
  }

  const claudeMdPath = join(agentDir, "CLAUDE.md");
  let claudeMd = await readFile(claudeMdPath, "utf8");

  const results = applyAuditImprovements(claudeMd, improvements);

  console.log(`\nImprovement plan for "${name}" (${apply ? "APPLYING" : "dry-run"}):\n`);
  for (const r of results) {
    console.log(`  [${r.section}]`);
    console.log(`    Current:   ${r.current.slice(0, 80).replace(/\n/g, "\\n")}`);
    console.log(`    Suggested: ${r.suggested.slice(0, 80).replace(/\n/g, "\\n")}`);
    console.log(`    Status:    ${r.found ? (apply ? "applying" : "would apply") : "NOT FOUND — skip"}`);
    console.log();
  }

  if (!apply) {
    const applyable = results.filter((r) => r.found).length;
    console.log(`Dry-run complete. ${applyable}/${results.length} patches would apply. Use --apply to write.`);
    return { applied: 0, skipped: results.length - applyable, total: results.length };
  }

  // Archive original before patching (META-02)
  const memoryDir = join(agentDir, ".claude", "memory");
  await mkdir(memoryDir, { recursive: true });
  const archivePath = join(memoryDir, `CLAUDE.md.bak-${ts()}`);
  await copyFile(claudeMdPath, archivePath);
  console.log(`Archived original to: ${archivePath}`);

  // Apply patches sequentially (META-01)
  let applied = 0;
  for (const r of results) {
    if (!r.found) continue;
    claudeMd = claudeMd.replace(r.current, r.suggested);
    applied++;
  }

  // Append changelog (META-04)
  const appliedSections = results.filter((r) => r.found).map((r) => r.section);
  const changelog = buildChangelogEntry(appliedSections, iso());
  claudeMd += changelog;

  await writeFile(claudeMdPath, claudeMd);

  // Report (META-05)
  const skipped = results.filter((r) => !r.found).map((r) => r.section);
  console.log(`\nApplied ${applied}/${results.length} patches.`);
  if (skipped.length > 0) {
    console.log(`Could not locate: ${skipped.join(", ")}`);
  }

  return { applied, skipped: results.length - applied, total: results.length };
}

// --- Autoresearch ---

export async function autoresearchAgent(name, {
  maxIterations = 10,
  costBudget = 5.0,
  minImprovement = 0.2,
  message = null,
  runsPerEval = 1,
  _evalFn = evalAgent,
  _auditFn = auditAgent,
  _improveFn = improveAgent,
} = {}) {
  const agentDir = join(_agentsDir, name);
  if (!(await exists(agentDir))) throw new Error(`Agent "${name}" not found`);

  const state = await readJson(join(agentDir, "state.json"));

  // Get baseline eval score
  let baseline = state.lastEval?.overall ?? null;
  if (baseline == null) {
    console.log(`[autoresearch] No baseline eval — running initial eval...`);
    const evalResult = await _evalFn(name, { verbose: false });
    baseline = evalResult?.overall ?? null;
    if (baseline == null) {
      console.log(`[autoresearch] Could not establish baseline — aborting.`);
      return { iterations: 0, improvements: 0, reversions: 0, totalCostUsd: 0 };
    }
  }
  console.log(`[autoresearch] Baseline score: ${baseline}/10`);

  let totalCostUsd = 0;
  let improvements = 0;
  let reversions = 0;
  let currentScore = baseline;
  let lastImprovedHash = null;
  let iterationsCompleted = 0;

  for (let i = 1; i <= maxIterations; i++) {
    console.log(`\n[autoresearch] === Iteration ${i}/${maxIterations} ===`);

    let action = "no_change";
    let hash = "";

    try {
      // Hash current CLAUDE.md
      const claudeMd = await readFile(join(agentDir, "CLAUDE.md"), "utf8");
      hash = computeClaudeMdHash(claudeMd);
      console.log(`[autoresearch] CLAUDE.md hash: ${hash}`);

      // Run agent
      for (let r = 0; r < runsPerEval; r++) {
        const agentState = await runAgent(name, {
          message: message || undefined,
          fresh: true,
        });
        const runCost = agentState.lastResult?.costUsd ?? 0;
        totalCostUsd += runCost;
      }

      // Eval (track cost if returned)
      const evalResult = await _evalFn(name, { verbose: false });
      if (evalResult?.costUsd != null) totalCostUsd += evalResult.costUsd;
      const score = evalResult?.overall ?? currentScore;

      const delta = score - baseline;

      if (delta >= minImprovement) {
        // Score improved — run audit + improve
        console.log(`[autoresearch] Score improved: ${baseline} → ${score} (Δ${delta.toFixed(1)})`);
        const auditResult = await _auditFn(name);
        if (auditResult?.costUsd != null) totalCostUsd += auditResult.costUsd;
        const improveResult = await _improveFn(name, { apply: true });

        if (improveResult?.applied > 0) {
          action = "improved";
          improvements++;
          baseline = score;
          lastImprovedHash = hash;
          console.log(`[autoresearch] Applied ${improveResult.applied} improvements. New baseline: ${baseline}`);
        } else {
          action = "no_improvements_available";
          baseline = score;
          console.log(`[autoresearch] Score improved but no patches to apply. Updated baseline: ${baseline}`);
        }
      } else if (delta < -minImprovement && lastImprovedHash) {
        // Score regressed after a previous improvement — revert
        console.log(`[autoresearch] Score regressed: ${baseline} → ${score} (Δ${delta.toFixed(1)}). Reverting...`);
        const reverted = await revertClaudeMd(agentDir);
        if (reverted) {
          action = "reverted";
          reversions++;
          lastImprovedHash = null;
          console.log(`[autoresearch] Reverted CLAUDE.md to previous backup.`);
        } else {
          action = "revert_failed";
          console.log(`[autoresearch] No backup found to revert.`);
        }
      } else {
        console.log(`[autoresearch] Score stable: ${score}/10 (Δ${delta.toFixed(1)} < threshold ${minImprovement})`);
      }

      currentScore = score;
    } catch (err) {
      action = "error";
      console.error(`[autoresearch] Iteration ${i} failed: ${err.message}`);
    }

    // Log experiment (even on error, to preserve cost tracking)
    await writeExperimentLog(agentDir, {
      iteration: i,
      score: currentScore,
      baseline,
      claudeMdHash: hash,
      action,
      costUsd: totalCostUsd,
      timestamp: iso(),
    });

    iterationsCompleted = i;

    // Check cost budget
    if (totalCostUsd >= costBudget) {
      console.log(`[autoresearch] Cost budget exhausted ($${totalCostUsd.toFixed(2)} >= $${costBudget.toFixed(2)})`);
      break;
    }
  }

  // Update state with autoresearch summary
  const updatedState = await readJson(join(agentDir, "state.json"));
  updatedState.autoresearch = {
    lastRun: iso(),
    iterations: iterationsCompleted,
    baselineScore: baseline,
    currentScore,
    totalCostUsd,
    improvements,
    reversions,
  };
  await writeJson(join(agentDir, "state.json"), updatedState);

  const summary = { iterations: iterationsCompleted, improvements, reversions, totalCostUsd, baselineScore: baseline, currentScore };

  console.log(`\n[autoresearch] Complete.`);
  console.log(`  Iterations:   ${summary.iterations}`);
  console.log(`  Improvements: ${improvements}`);
  console.log(`  Reversions:   ${reversions}`);
  console.log(`  Score:        ${baseline} → ${currentScore}`);
  console.log(`  Total cost:   $${totalCostUsd.toFixed(4)}`);

  return summary;
}

// --- Variant Competition ---

export function generateVariantSubsets(improvements, count) {
  const results = [];
  for (let i = 0; i < count; i++) {
    const shuffled = [...improvements];
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    const size = Math.max(1, Math.floor(Math.random() * shuffled.length) + 1);
    results.push(shuffled.slice(0, size));
  }
  return results;
}

export async function cloneAgent(srcName, dstName, claudeMdOverride = null) {
  const srcDir = join(_agentsDir, srcName);
  const dstDir = join(_agentsDir, dstName);
  if (!(await exists(srcDir))) throw new Error(`Agent "${srcName}" not found`);

  await cp(srcDir, dstDir, { recursive: true });

  if (claudeMdOverride) {
    await writeFile(join(dstDir, "CLAUDE.md"), claudeMdOverride);
  }

  // Reset variant state
  const state = { status: "idle", runCount: 0, lastRun: null, lastResult: null, lastError: null };
  await writeJson(join(dstDir, "state.json"), state);

  return dstDir;
}

export async function cleanupVariants(name, count) {
  for (let i = 1; i <= count; i++) {
    const variantDir = join(_agentsDir, `${name}-variant-${i}`);
    if (await exists(variantDir)) {
      await rm(variantDir, { recursive: true, force: true });
    }
  }
}

export async function competeAgent(name, {
  variants = 3,
  message = null,
  _evalFn = evalAgent,
  _auditFn = auditAgent,
} = {}) {
  const agentDir = join(_agentsDir, name);
  if (!(await exists(agentDir))) throw new Error(`Agent "${name}" not found`);

  console.log(`[compete] Starting variant competition for "${name}" (${variants} variants)`);

  // Step 1: Audit to get improvements
  console.log(`[compete] Running audit...`);
  const auditResult = await _auditFn(name);
  const improvements = auditResult?.improvements || [];
  if (improvements.length === 0) {
    console.log(`[compete] No improvements available — nothing to compete.`);
    return { winner: null, scores: [], improved: false };
  }

  console.log(`[compete] Found ${improvements.length} improvements. Generating ${variants} variants...`);

  // Step 2: Generate variant CLAUDE.mds
  const originalClaudeMd = await readFile(join(agentDir, "CLAUDE.md"), "utf8");
  const subsets = generateVariantSubsets(improvements, variants);

  // Step 3: Create variant agents and run them
  const variantScores = [];

  try {
    for (let i = 1; i <= variants; i++) {
      const variantName = `${name}-variant-${i}`;
      const subset = subsets[i - 1];

      // Apply this variant's subset of improvements
      let variantMd = originalClaudeMd;
      for (const imp of subset) {
        if (variantMd.includes(imp.current)) {
          variantMd = variantMd.replace(imp.current, imp.suggested);
        }
      }

      await cloneAgent(name, variantName, variantMd);
      console.log(`[compete] Running variant ${i}/${variants} (${subset.length} improvements)...`);

      // Run + eval variant
      await runAgent(variantName, { message: message || undefined, fresh: true });
      const evalResult = await _evalFn(variantName, { verbose: false });
      const score = evalResult?.overall ?? 0;
      variantScores.push({ variant: i, name: variantName, score, subset });
      console.log(`[compete] Variant ${i} scored: ${score}/10`);
    }

    // Step 4: Also eval the original (baseline)
    console.log(`[compete] Running original for baseline...`);
    await runAgent(name, { message: message || undefined, fresh: true });
    const baselineEval = await _evalFn(name, { verbose: false });
    const baselineScore = baselineEval?.overall ?? 0;
    console.log(`[compete] Original scored: ${baselineScore}/10`);

    // Step 5: Pick winner
    const allScores = [{ variant: 0, name, score: baselineScore, subset: [] }, ...variantScores];
    allScores.sort((a, b) => b.score - a.score);
    const winner = allScores[0];

    if (winner.variant > 0 && winner.score > baselineScore) {
      // Winner is a variant — copy its CLAUDE.md to the original
      const winnerMd = await readFile(join(_agentsDir, winner.name, "CLAUDE.md"), "utf8");

      // Archive original
      const memoryDir = join(agentDir, ".claude", "memory");
      await mkdir(memoryDir, { recursive: true });
      await copyFile(join(agentDir, "CLAUDE.md"), join(memoryDir, `CLAUDE.md.bak-${ts()}`));

      await writeFile(join(agentDir, "CLAUDE.md"), winnerMd);
      console.log(`\n[compete] Winner: variant ${winner.variant} (${winner.score}/10 vs baseline ${baselineScore}/10)`);
      console.log(`[compete] Applied ${winner.subset.length} improvements to "${name}"`);
      return { winner: winner.variant, scores: allScores, improved: true, baselineScore, winnerScore: winner.score };
    } else {
      console.log(`\n[compete] Original wins (${baselineScore}/10). No improvements applied.`);
      return { winner: null, scores: allScores, improved: false, baselineScore, winnerScore: baselineScore };
    }
  } finally {
    // Step 6: Cleanup
    await cleanupVariants(name, variants);
  }
}

// --- Genetic Optimization ---

export async function evolveAgent(name, {
  generations = 5,
  variants = 3,
  message = null,
  _evalFn = evalAgent,
  _auditFn = auditAgent,
} = {}) {
  const agentDir = join(_agentsDir, name);
  if (!(await exists(agentDir))) throw new Error(`Agent "${name}" not found`);

  console.log(`[evolve] Starting evolution for "${name}" (${generations} generations, ${variants} variants each)`);

  const history = [];

  for (let gen = 1; gen <= generations; gen++) {
    console.log(`\n[evolve] === Generation ${gen}/${generations} ===`);

    const result = await competeAgent(name, { variants, message, _evalFn, _auditFn });
    history.push({ generation: gen, ...result });

    if (!result.improved) {
      console.log(`[evolve] No improvement in generation ${gen} — stopping early.`);
      break;
    }

    if (result.winnerScore >= 10) {
      console.log(`[evolve] Perfect score reached — stopping.`);
      break;
    }
  }

  // Log evolution results
  const expDir = join(agentDir, "experiments");
  await mkdir(expDir, { recursive: true });
  await appendFile(join(expDir, "evolution.jsonl"), JSON.stringify({ timestamp: iso(), generations: history.length, history }) + "\n");

  console.log(`\n[evolve] Evolution complete.`);
  console.log(`  Generations: ${history.length}`);
  const improved = history.filter(h => h.improved).length;
  console.log(`  Improved:    ${improved}/${history.length}`);
  if (history.length > 0) {
    const first = history[0].baselineScore ?? "?";
    const last = history[history.length - 1].winnerScore ?? history[history.length - 1].baselineScore ?? "?";
    console.log(`  Score:       ${first} → ${last}`);
  }

  return { generations: history.length, history };
}

// --- Daemon ---

async function startDaemon({ maxConcurrent = 3 } = {}) {
  console.log(
    `Agent orchestrator daemon started (poll: ${DAEMON_POLL_INTERVAL / 1000}s, max concurrent: ${maxConcurrent})`,
  );
  console.log(`Agents directory: ${_agentsDir}`);
  console.log(`PID: ${process.pid}\n`);

  const active = new Map(); // name -> promise
  let running = true;

  const shutdown = () => {
    if (!running) return;
    console.log("\nShutting down daemon...");
    running = false;
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Startup recovery — run once before polling loop
  await recoverStalePipelineRuns(); // EXEC-03

  while (running) {
    try {
      const agents = await loadAgents();
      await recoverStaleAgents(agents); // CRASH-01/02/03

      for (const agent of agents) {
        if (!agent.config.schedule) continue;
        if (active.has(agent.name)) continue;
        if (agent.state.pipelineRunId) continue; // COEX-01: skip pipeline workers
        if (active.size >= maxConcurrent) continue;

        const interval = agent.config.schedule.intervalSeconds * 1000;
        const lastRun = agent.state.lastRun
          ? new Date(agent.state.lastRun).getTime()
          : 0;

        if (Date.now() - lastRun < interval) continue;

        // Reset budget_exceeded agents on new calendar day (COST-05)
        if (agent.state.status === "budget_exceeded") {
          const today = new Date().toLocaleDateString("en-CA");
          const costDate = agent.state.dailyCost?.date;
          if (!costDate || costDate < today) {
            agent.state.status = "idle";
            agent.state.dailyCost = { date: today, totalUsd: 0 };
            await writeJson(join(_agentsDir, agent.name, "state.json"), agent.state);
            console.log(`[${iso()}] Agent "${agent.name}" budget reset for new day`);
            // fall through to normal scheduling
          } else {
            continue; // still same day, skip silently
          }
        }

        // Skip auth_error permanently (no log per tick — already logged on transition)
        if (agent.state.status === "auth_error") continue;
        // Respect backoff window
        if (agent.state.nextRetryAfter &&
            Date.now() < new Date(agent.state.nextRetryAfter).getTime()) continue;

        {
          console.log(`[${iso()}] Spawning agent "${agent.name}"`);

          const promise = runAgent(agent.name)
            .catch((err) =>
              console.error(`Agent "${agent.name}" error: ${err.message}`),
            )
            .finally(() => active.delete(agent.name));

          active.set(agent.name, promise);
        }
      }
    } catch (err) {
      console.error(`Daemon loop error: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, DAEMON_POLL_INTERVAL));
  }

  // Wait for active agents
  if (active.size > 0) {
    console.log(`Waiting for ${active.size} active agent(s) to finish...`);
    await Promise.allSettled(active.values());
  }

  console.log("Daemon stopped.");
}

export function createMutex() {
  let chain = Promise.resolve();
  return (fn) => { chain = chain.catch(() => {}).then(fn); return chain; };
}

export async function runPipelineStage(agentName, stage, runState, pipelineCtx, statePath, mutex = null) {
  const writeState = mutex
    ? () => mutex(() => writeAtomicJson(statePath, runState))
    : () => writeAtomicJson(statePath, runState);
  const stageOutputDir = join(
    _pipelinesDir,
    pipelineCtx.pipelineName,
    "runs",
    pipelineCtx.runId,
    stage.name,
  );
  await mkdir(stageOutputDir, { recursive: true });

  const outputFile = join(stageOutputDir, "output");
  const agentDir = join(_agentsDir, agentName);
  const config = await readAgentConfig(agentDir);

  // Per-stage config overrides (COEX-03)
  if (stage.model) config.model = stage.model;
  if (stage.maxTurns) config.maxTurns = stage.maxTurns;
  if (stage.timeout) config.timeoutMs = stage.timeout;

  const startedAt = iso();
  const agentStatePath = join(agentDir, "state.json");

  // Set pipelineRunId so daemon skips this agent while it's running as a pipeline worker (COEX-01)
  const agentStateBefore = await readJson(agentStatePath);
  agentStateBefore.pipelineRunId = pipelineCtx.runId;
  await writeJson(agentStatePath, agentStateBefore);

  let gateFeedback = null;

  try {
  while (true) {
    // Mark stage as running
    runState.stages[stage.name].status = "running";
    runState.stages[stage.name].startedAt = startedAt;
    await writeState();

    const workerPrompt = buildPipelineWorkerPrompt(config, agentDir, stageOutputDir, stage, pipelineCtx, gateFeedback);

    const agentState = await runAgent(agentName, {
      message: workerPrompt,
      fresh: true,
      outputFile,
      suppressEval: true,
    });

    const exitCode = agentState.lastResult?.exitCode ?? 1;
    let costUsd = agentState.lastResult?.costUsd ?? null;
    const durationMs = agentState.lastResult?.durationMs ?? null;
    const completedAt = iso();

    // Resolve activity log path for gate enrichment
    const runTimestamp = agentState.lastResult?.timestamp;
    const activityPath = runTimestamp
      ? join(_agentsDir, agentName, "runs", runTimestamp, "activity.jsonl")
      : null;

    if (exitCode === 0) {
      // --- Gate check (GATE-01) ---
      const gateDecision = await runGateCheck(stage, outputFile, pipelineCtx, gateFeedback, AGENT_TIMEOUT, activityPath);

      // Accumulate gate cost into stage total
      if (gateDecision.costUsd != null) {
        costUsd = (costUsd ?? 0) + gateDecision.costUsd;
      }

      if (gateDecision.action === "infrastructure_failure") {
        // GATE-05: spawn/timeout failure -> stage failed, not aborted
        runState.stages[stage.name].status = "failed";
        runState.stages[stage.name].completedAt = iso();
        runState.stages[stage.name].durationMs = Date.now() - Date.parse(startedAt);
        runState.stages[stage.name].exitCode = exitCode;
        runState.stages[stage.name].costUsd = costUsd;
        runState.stages[stage.name].gateDecision = "infrastructure_failure";
        runState.stages[stage.name].gateReason = gateDecision.error;
        await writeState();
        return { success: false };
      }

      if (gateDecision.action === "proceed") {
        runState.stages[stage.name].status = "passed";
        runState.stages[stage.name].completedAt = completedAt;
        runState.stages[stage.name].durationMs = durationMs;
        runState.stages[stage.name].exitCode = exitCode;
        runState.stages[stage.name].costUsd = costUsd;
        runState.stages[stage.name].outputPath = outputFile;
        await writeState();
        return { success: true };
      }

      if (gateDecision.action === "retry") {
        // GATE-03: increment retryCount BEFORE re-spawn (crash-safe)
        runState.stages[stage.name].retryCount = (runState.stages[stage.name].retryCount || 0) + 1;
        runState.stages[stage.name].gateDecision = "retry";
        runState.stages[stage.name].gateReason = gateDecision.feedback ?? "";
        await writeState();

        const retryCount = runState.stages[stage.name].retryCount;
        const maxRetries = stage.max_retries ?? 0;

        if (retryCount < maxRetries) {
          console.log(`[gate] Stage "${stage.name}" retry requested (${retryCount}/${maxRetries}): ${gateDecision.feedback ?? ""}`);
          gateFeedback = gateDecision.feedback ?? "";
          // loop continues with feedback injected
        } else {
          console.log(`[gate] Stage "${stage.name}" max retries exhausted after gate retry`);
          runState.stages[stage.name].status = "failed";
          runState.stages[stage.name].completedAt = iso();
          runState.stages[stage.name].costUsd = costUsd;
          await writeState();
          return { success: false };
        }
      }

      if (gateDecision.action === "abort") {
        // GATE-04: supervisor abort -> stage failed with gate-rejected
        runState.stages[stage.name].status = "failed";
        runState.stages[stage.name].completedAt = iso();
        runState.stages[stage.name].costUsd = costUsd;
        runState.stages[stage.name].gateDecision = "abort";
        runState.stages[stage.name].gateReason = gateDecision.reason ?? "";
        await writeState();
        return { success: false, aborted: true, reason: gateDecision.reason ?? "" };
      }
    } else {
      runState.stages[stage.name].retryCount = (runState.stages[stage.name].retryCount || 0) + 1;
      const retryCount = runState.stages[stage.name].retryCount;
      const maxRetries = stage.max_retries ?? 0;

      if (retryCount < maxRetries) {
        console.log(`[pipeline] Stage "${stage.name}" failed (exit ${exitCode}), retrying (${retryCount}/${maxRetries})...`);
        // loop continues — retry
      } else {
        runState.stages[stage.name].status = "failed";
        runState.stages[stage.name].completedAt = completedAt;
        runState.stages[stage.name].durationMs = durationMs;
        runState.stages[stage.name].exitCode = exitCode;
        runState.stages[stage.name].costUsd = costUsd;
        await writeState();
        return { success: false };
      }
    }
  }
  } finally {
    // Always clear pipelineRunId so daemon can schedule this agent again (COEX-01)
    const agentStateAfter = await readJson(agentStatePath);
    agentStateAfter.pipelineRunId = null;
    await writeJson(agentStatePath, agentStateAfter);
  }
}

export async function runPipeline(name) {
  const pipeline = await loadPipeline(name);

  const runId = ts();
  const runDir = join(_pipelinesDir, name, "runs", runId);
  await mkdir(runDir, { recursive: true });

  const stageNames = pipeline.stages.map(s => s.name);
  const runState = initRunState(name, runId, stageNames);
  runState.status = "running";
  runState.startedAt = iso();
  runState.runningPid = process.pid;

  const statePath = join(runDir, "state.json");
  await writeAtomicJson(statePath, runState);

  console.log(`[pipeline] Starting run: ${name} / ${runId}`);

  const startEpoch = Date.now();
  const stageOutputs = {};
  const mutex = createMutex();

  let failed = false;

  for (const level of pipeline.levels) {
    if (level.length === 1) {
      // Single stage — run sequentially (no mutex overhead)
      const stage = level[0];
      const pipelineCtx = { pipelineName: name, runId, stageOutputs };
      const stageResult = await runPipelineStage(stage.agent, stage, runState, pipelineCtx, statePath);

      if (stageResult.success) {
        stageOutputs[stage.name] = join(_pipelinesDir, name, "runs", runId, stage.name, "output");
      } else {
        if (stageResult.aborted) {
          runState.status = "aborted";
          runState.abortedReason = stageResult.reason;
        } else {
          failed = true;
        }
        break;
      }
    } else {
      // Multiple stages — run in parallel with mutex for state writes
      const results = await Promise.all(level.map(stage => {
        const pipelineCtx = { pipelineName: name, runId, stageOutputs };
        return runPipelineStage(stage.agent, stage, runState, pipelineCtx, statePath, mutex)
          .then(result => ({ stage, result }));
      }));

      for (const { stage, result } of results) {
        if (result.success) {
          stageOutputs[stage.name] = join(_pipelinesDir, name, "runs", runId, stage.name, "output");
        } else {
          if (result.aborted) {
            runState.status = "aborted";
            runState.abortedReason = result.reason;
          } else {
            failed = true;
          }
        }
      }

      if (failed || runState.status === "aborted") break;
    }
  }

  // Mark remaining pending stages as skipped
  for (const stage of pipeline.stages) {
    if (runState.stages[stage.name].status === "pending") {
      runState.stages[stage.name].status = "skipped";
    }
  }

  // Sum stage costs into totalCostUsd
  runState.totalCostUsd = 0;
  for (const entry of Object.values(runState.stages)) {
    if (entry.costUsd != null) runState.totalCostUsd += entry.costUsd;
  }

  if (runState.status !== "aborted") {
    runState.status = failed ? "failed" : "completed";
  }
  runState.completedAt = iso();
  runState.runningPid = null;
  await writeAtomicJson(statePath, runState);

  const durationSec = ((Date.now() - startEpoch) / 1000).toFixed(1);
  const totalCost = runState.totalCostUsd ? `$${runState.totalCostUsd.toFixed(4)}` : "$0.0000";

  console.log(`\n[pipeline] Run complete: ${name}`);
  console.log(`  Run ID:   ${runId}`);
  console.log(`  Status:   ${runState.status}`);
  console.log(`  Duration: ${durationSec}s`);
  console.log(`  Cost:     ${totalCost}`);
  console.log(`  State:    ${statePath}`);

  if (failed || runState.status === "aborted") {
    process.exit(1);
  }
}

async function validatePipeline(name) {
  try {
    const pipeline = await loadPipeline(name);
    const agentNames = [...new Set(pipeline.stages.map(s => s.agent))];

    console.log(`Pipeline: ${pipeline.name} (version ${pipeline.version})`);
    console.log();
    console.log("Stages:");
    for (const stage of pipeline.stages) {
      const deps = (stage.depends_on || []).length > 0
        ? `     <-- ${stage.depends_on.join(", ")}`
        : "     (no dependencies)";
      console.log(`  ${stage.name}${deps}`);
    }
    console.log();
    console.log(`${pipeline.stages.length} stages, ${agentNames.length} agent(s): ${agentNames.join(", ")}`);
    console.log("All agents exist. No cycles detected.");
    console.log("Validation passed.");
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

async function listPipelineRuns() {
  if (!(await exists(_pipelinesDir))) {
    console.log("No pipelines found.");
    return;
  }
  const pipelineDirs = await readdir(_pipelinesDir, { withFileTypes: true });
  const pipelines = pipelineDirs.filter(d => d.isDirectory());
  if (pipelines.length === 0) {
    console.log("No pipelines found.");
    return;
  }

  for (const entry of pipelines) {
    const runsDir = join(_pipelinesDir, entry.name, "runs");
    if (!(await exists(runsDir))) {
      console.log(`${entry.name}: no runs`);
      continue;
    }
    const runs = (await readdir(runsDir)).sort().reverse();
    if (runs.length === 0) {
      console.log(`${entry.name}: no runs`);
      continue;
    }

    console.log(`\n${entry.name} (${runs.length} run(s)):`);
    for (const runId of runs.slice(0, 5)) {
      const statePath = join(runsDir, runId, "state.json");
      try {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        const cost = state.totalCostUsd ? `$${state.totalCostUsd.toFixed(2)}` : "";
        console.log(`  ${runId}  ${pad(state.status, 12)} ${cost}`);
      } catch {
        console.log(`  ${runId}  (no state)`);
      }
    }
    if (runs.length > 5) console.log(`  ... and ${runs.length - 5} more`);
  }
  console.log();
}

async function showPipelineStatus(runId) {
  if (!runId) {
    console.error("Usage: orchestrator pipeline status <run-id>");
    process.exit(1);
  }

  // Scan all pipeline run directories to find matching runId
  let foundStatePath = null;
  let foundPipelineName = null;

  if (await exists(_pipelinesDir)) {
    const pipelineDirs = await readdir(_pipelinesDir, { withFileTypes: true });
    for (const entry of pipelineDirs) {
      if (!entry.isDirectory()) continue;
      const runsDir = join(_pipelinesDir, entry.name, "runs", runId);
      const candidate = join(runsDir, "state.json");
      if (await exists(candidate)) {
        foundStatePath = candidate;
        foundPipelineName = entry.name;
        break;
      }
    }
  }

  if (!foundStatePath) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }

  const state = await readJson(foundStatePath);

  const fmtDurationMs = (ms) => {
    if (ms == null) return "-";
    const totalSec = Math.round(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  const fmtCost = (usd) => (usd != null ? `$${usd.toFixed(4)}` : "-");

  const fmtDate = (iso) => (iso ? iso.replace("T", " ").replace("Z", "") : "-");

  let durationLine;
  if (state.completedAt && state.startedAt) {
    const ms = new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime();
    durationLine = fmtDurationMs(ms);
  } else if (state.status === "running") {
    durationLine = "running...";
  } else {
    durationLine = "-";
  }

  console.log(`Pipeline Run: ${foundPipelineName} / ${runId}`);
  console.log(`  Status:   ${state.status}`);
  if (state.status === "aborted" && state.abortedReason) {
    console.log(`  Abort reason: ${state.abortedReason}`);
  }
  console.log(`  Started:  ${fmtDate(state.startedAt)}`);
  console.log(`  Duration: ${durationLine}`);
  console.log(`  Cost:     ${fmtCost(state.totalCostUsd)}`);
  console.log();
  console.log("  Stages:");

  for (const [stageName, stageState] of Object.entries(state.stages)) {
    const stageStatus = stageState.status ?? "pending";
    let stageDuration;
    if (stageState.durationMs != null) {
      stageDuration = fmtDurationMs(stageState.durationMs);
    } else if (stageStatus === "running") {
      stageDuration = "running...";
    } else {
      stageDuration = "-";
    }
    const stageCost = fmtCost(stageState.costUsd);
    console.log(`    ${stageName.padEnd(16)} ${stageStatus.padEnd(10)} ${stageDuration.padEnd(12)} ${stageCost}`);
  }
}

// --- Scheduling ---
//
// Install a per-agent cron trigger using the native scheduler:
//   - macOS  → launchd plist under ~/Library/LaunchAgents
//   - Linux  → user crontab line marked with `# agent-orchestrator:<name>`
//
// Cron and the daemon loop's interval are mutually exclusive per agent —
// `schedule --cron` refuses to install if intervalSeconds is set unless --force.

const DEFAULT_LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
let LAUNCH_AGENTS_DIR = DEFAULT_LAUNCH_AGENTS_DIR;
const CRON_MARKER_PREFIX = "# agent-orchestrator:";

// XML-escape plist string content
function xmlEscape(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Expand schedule sugar like "hourly", "daily HH:MM", "weekly [DOW] HH:MM", "weekdays HH:MM"
// to a canonical 5-field cron expression.
export function expandScheduleSugar(sugar) {
  const accepted = `Accepted forms: "hourly", "daily HH:MM", "weekdays HH:MM", "weekly [mon|tue|wed|thu|fri|sat|sun] HH:MM"`;
  if (typeof sugar !== "string") {
    throw new Error(`Invalid schedule sugar: ${sugar}. ${accepted}`);
  }
  const s = sugar.trim().toLowerCase();
  if (!s) throw new Error(`Empty schedule sugar. ${accepted}`);

  if (s === "hourly") return "0 * * * *";

  const parseTime = (t) => {
    const m = /^([0-1]?\d|2[0-3]):([0-5]\d)$/.exec(t);
    if (!m) throw new Error(`Invalid time "${t}" — expected HH:MM. ${accepted}`);
    return { hh: parseInt(m[1], 10), mm: parseInt(m[2], 10) };
  };

  const daily = /^daily\s+(\S+)$/.exec(s);
  if (daily) {
    const { hh, mm } = parseTime(daily[1]);
    return `${mm} ${hh} * * *`;
  }

  const weekdays = /^weekdays\s+(\S+)$/.exec(s);
  if (weekdays) {
    const { hh, mm } = parseTime(weekdays[1]);
    return `${mm} ${hh} * * 1-5`;
  }

  const dowMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const weekly = /^weekly(?:\s+(sun|mon|tue|wed|thu|fri|sat))?\s+(\S+)$/.exec(s);
  if (weekly) {
    const dow = weekly[1] ? dowMap[weekly[1]] : 0; // default Sunday
    const { hh, mm } = parseTime(weekly[2]);
    return `${mm} ${hh} * * ${dow}`;
  }

  throw new Error(`Unknown schedule sugar "${sugar}". ${accepted}`);
}

// Validate a single cron field against its allowed range.
// Accepts: "*", number, "A-B" range, comma-list of the above, "*/N" step.
function validateCronField(field, min, max, label) {
  const check = (tok) => {
    // "*"
    if (tok === "*") return;
    // "*/N" step
    let m = /^\*\/(\d+)$/.exec(tok);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n < 1 || n > max) {
        throw new Error(`Invalid step in ${label}: ${tok}`);
      }
      return;
    }
    // "A-B" range
    m = /^(\d+)-(\d+)$/.exec(tok);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (a < min || b > max || a > b) {
        throw new Error(`Invalid range in ${label}: ${tok} (must be ${min}-${max})`);
      }
      return;
    }
    // single number
    m = /^(\d+)$/.exec(tok);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n < min || n > max) {
        throw new Error(`Invalid value in ${label}: ${n} (must be ${min}-${max})`);
      }
      return;
    }
    throw new Error(`Invalid token in ${label}: "${tok}"`);
  };

  const parts = field.split(",");
  if (parts.length === 0 || parts.some((p) => p === "")) {
    throw new Error(`Invalid ${label}: "${field}"`);
  }
  parts.forEach(check);
}

const CRON_SUGAR_HINT =
  `Tip: try one of these sugar forms via --at: "hourly", "daily HH:MM", "weekdays HH:MM", "weekly <mon-sun> HH:MM"`;

// Validate a 5-field cron expression. Throws on invalid.
export function validateCronExpr(expr) {
  try {
    if (typeof expr !== "string") throw new Error("Cron expression must be a string");
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) {
      throw new Error(`Cron expression must have 5 fields (got ${fields.length}): "${expr}"`);
    }
    const [minute, hour, dom, month, dow] = fields;
    validateCronField(minute, 0, 59, "minute");
    validateCronField(hour, 0, 23, "hour");
    validateCronField(dom, 1, 31, "day-of-month");
    validateCronField(month, 1, 12, "month");
    // cron day-of-week: 0-7 where both 0 and 7 mean Sunday
    validateCronField(dow, 0, 7, "day-of-week");
    return { minute, hour, dom, month, dow };
  } catch (err) {
    throw new Error(`${err.message}\n${CRON_SUGAR_HINT}`);
  }
}

// Expand a single cron field to an explicit array of values, or null if wildcard.
// Supports "*", number, "A-B", comma-list, and "*/N" over the full field range.
function expandCronField(field, min, max) {
  if (field === "*") return null;

  // "*/N" over the full range → [min, min+N, min+2N, ...]
  const step = /^\*\/(\d+)$/.exec(field);
  if (step) {
    const n = parseInt(step[1], 10);
    const out = [];
    for (let v = min; v <= max; v += n) out.push(v);
    return out;
  }

  const values = new Set();
  for (const tok of field.split(",")) {
    const range = /^(\d+)-(\d+)$/.exec(tok);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      for (let v = a; v <= b; v++) values.add(v);
      continue;
    }
    const one = /^(\d+)$/.exec(tok);
    if (one) {
      values.add(parseInt(one[1], 10));
      continue;
    }
    // Unsupported shape (e.g. range-with-step "0-30/5") — fail with clear message
    throw new Error(
      `Cannot translate cron field "${field}" to launchd — simplify to number, range (A-B), list (A,B,C), or step (*/N).`,
    );
  }
  return [...values].sort((a, b) => a - b);
}

// Convert a cron expression to a launchd StartCalendarInterval payload.
// Returns a plain object or an array of objects (when multiple minute+hour combos needed).
// Throws if the expression can't be represented.
export function cronToLaunchdInterval(expr) {
  const { minute, hour, dom, month, dow } = validateCronExpr(expr);

  // launchd ANDs DayOfMonth + Weekday, while cron ORs them when both are non-"*".
  // Refuse the ambiguous case rather than silently mis-schedule.
  if (dom !== "*" && dow !== "*") {
    throw new Error(
      `Cannot translate cron "${expr}" to launchd: both day-of-month and day-of-week are set ` +
      `(cron ORs them, launchd ANDs them). Simplify one field to "*" or install this schedule on Linux via crontab.`,
    );
  }

  const minutes = expandCronField(minute, 0, 59);
  const hours = expandCronField(hour, 0, 23);
  const doms = expandCronField(dom, 1, 31);
  const months = expandCronField(month, 1, 12);
  // Normalize cron 7 (Sunday) → 0 for launchd (Weekday 0-6)
  let dows = expandCronField(dow, 0, 7);
  if (dows) {
    dows = [...new Set(dows.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  }

  // Build a cartesian product of non-wildcard fields into launchd dicts.
  const minuteList = minutes ?? [null];
  const hourList = hours ?? [null];
  const domList = doms ?? [null];
  const monthList = months ?? [null];
  const dowList = dows ?? [null];

  const dicts = [];
  for (const mi of minuteList) {
    for (const hr of hourList) {
      for (const d of domList) {
        for (const mo of monthList) {
          for (const w of dowList) {
            const entry = {};
            if (mi != null) entry.Minute = mi;
            if (hr != null) entry.Hour = hr;
            if (d != null) entry.Day = d;
            if (mo != null) entry.Month = mo;
            if (w != null) entry.Weekday = w;
            dicts.push(entry);
          }
        }
      }
    }
  }

  if (dicts.length === 0 || (dicts.length === 1 && Object.keys(dicts[0]).length === 0)) {
    // Entirely-wildcard expression "* * * * *" — launchd can't express "every minute".
    throw new Error(
      `Cron "${expr}" matches every minute; launchd cannot express that via StartCalendarInterval.`,
    );
  }
  return dicts.length === 1 ? dicts[0] : dicts;
}

// Render a launchd dict (key/value object) as plist XML.
function renderLaunchdDict(dict, indent) {
  const lines = [`${indent}<dict>`];
  for (const [k, v] of Object.entries(dict)) {
    lines.push(`${indent}  <key>${xmlEscape(k)}</key>`);
    lines.push(`${indent}  <integer>${v}</integer>`);
  }
  lines.push(`${indent}</dict>`);
  return lines.join("\n");
}

// Build a complete launchd plist for the given agent + cron expression.
// Pure function: inputs go in, XML string comes out.
export function cronToLaunchdPlist({ label, cronExpr, nodePath, orchestratorPath, workingDir, agentName, stdoutPath, stderrPath }) {
  const interval = cronToLaunchdInterval(cronExpr);

  let intervalBlock;
  if (Array.isArray(interval)) {
    const items = interval.map((d) => renderLaunchdDict(d, "    ")).join("\n");
    intervalBlock = `  <key>StartCalendarInterval</key>\n  <array>\n${items}\n  </array>`;
  } else {
    intervalBlock = `  <key>StartCalendarInterval</key>\n${renderLaunchdDict(interval, "  ")}`;
  }

  const programArgs = [nodePath, orchestratorPath, "run", agentName]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workingDir)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
  <key>RunAtLoad</key>
  <false/>
${intervalBlock}
</dict>
</plist>
`;
}

// Build the canonical crontab line for an agent.
export function buildCrontabLine({ cronExpr, projectRoot, nodePath, orchestratorPath, agentName }) {
  validateCronExpr(cronExpr);
  const marker = `${CRON_MARKER_PREFIX}${agentName}`;
  // Redirect stdout/stderr to the agent's runs dir so cron doesn't email the user.
  const logDir = join(projectRoot, "agents", agentName, "runs");
  const cmd = `cd ${projectRoot} && ${nodePath} ${orchestratorPath} run ${agentName} >> ${logDir}/cron.log 2>&1`;
  return `${cronExpr} ${cmd} ${marker}`;
}

// Parse a crontab string and strip out any lines tagged for this agent.
// Returns the filtered string (without trailing newline normalization).
export function stripCrontabForAgent(crontabText, agentName) {
  const marker = `${CRON_MARKER_PREFIX}${agentName}`;
  const lines = (crontabText ?? "").split("\n");
  return lines.filter((l) => !l.includes(marker)).join("\n");
}

// Read the current user's crontab. Returns "" if user has no crontab.
async function readCrontab() {
  try {
    const { stdout } = await _execFn("crontab -l");
    return stdout;
  } catch (err) {
    // `crontab -l` exits 1 with "no crontab for USER" when empty — treat as empty
    const msg = `${err.stderr || ""}${err.message || ""}`;
    if (/no crontab/i.test(msg)) return "";
    throw err;
  }
}

// Write the given text as the user's new crontab (atomic via tmpfile + `crontab <file>`).
async function writeCrontab(text) {
  const tmpFile = join(tmpdir(), `agent-orchestrator-crontab-${Date.now()}-${process.pid}`);
  try {
    // Ensure trailing newline — crontab tolerates but produces cleaner diffs
    const normalized = text.endsWith("\n") ? text : text + "\n";
    await writeFile(tmpFile, normalized);
    await _execFn(`crontab ${tmpFile}`);
  } finally {
    try { await unlink(tmpFile); } catch {}
  }
}

// Install a cron schedule via crontab. Returns the line that was installed.
async function installCrontab(agentName, cronExpr) {
  const current = await readCrontab();
  const stripped = stripCrontabForAgent(current, agentName);
  const line = buildCrontabLine({
    cronExpr,
    projectRoot: ROOT,
    nodePath: process.execPath,
    orchestratorPath: ORCHESTRATOR_PATH,
    agentName,
  });
  // Normalize: ensure stripped section ends with exactly one newline before appending
  const base = stripped.replace(/\n*$/, "");
  const newCrontab = (base ? base + "\n" : "") + line + "\n";
  await writeCrontab(newCrontab);

  // Round-trip verify: read it back and confirm the marker line survived verbatim
  const after = await readCrontab();
  if (!after.includes(line)) {
    throw new Error(
      `Crontab round-trip verification failed — installed line is missing after write.`,
    );
  }
  return line;
}

// Remove any crontab lines for this agent. Idempotent.
async function removeCrontab(agentName) {
  const current = await readCrontab();
  const marker = `${CRON_MARKER_PREFIX}${agentName}`;
  if (!current.includes(marker)) return false; // nothing to remove
  const stripped = stripCrontabForAgent(current, agentName);
  await writeCrontab(stripped.replace(/\n*$/, "\n"));
  return true;
}

// macOS install: write plist, lint, then bootstrap/load.
export async function installLaunchd(agentName, cronExpr) {
  const label = `com.agent-orchestrator.${agentName}`;
  const plistPath = join(LAUNCH_AGENTS_DIR, `${label}.plist`);
  const agentDir = join(_agentsDir, agentName);
  const runsDir = join(agentDir, "runs");
  await mkdir(runsDir, { recursive: true });
  await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });

  const plist = cronToLaunchdPlist({
    label,
    cronExpr,
    nodePath: process.execPath,
    orchestratorPath: ORCHESTRATOR_PATH,
    workingDir: ROOT,
    agentName,
    stdoutPath: join(runsDir, "launchd-stdout.log"),
    stderrPath: join(runsDir, "launchd-stderr.log"),
  });

  // Atomic write via tmp + rename
  const tmp = plistPath + ".tmp";
  await writeFile(tmp, plist);
  await rename(tmp, plistPath);

  // Lint before loading
  try {
    await _execFn(`plutil -lint ${JSON.stringify(plistPath)}`);
  } catch (err) {
    // Clean up the bad plist so we don't leave corrupt state behind
    try { await unlink(plistPath); } catch {}
    throw new Error(`plutil -lint failed for ${plistPath}: ${err.stderr || err.message}`);
  }

  // Unload any previous version of this label before loading — idempotent install
  const uid = process.getuid ? process.getuid() : 0;
  try {
    await _execFn(`launchctl bootout gui/${uid}/${label}`);
  } catch {
    // not loaded; ignore
  }
  try {
    await _execFn(`launchctl bootstrap gui/${uid} ${JSON.stringify(plistPath)}`);
  } catch (bootstrapErr) {
    // Fallback for older macOS
    try {
      await _execFn(`launchctl load ${JSON.stringify(plistPath)}`);
    } catch (loadErr) {
      // Clean up the orphan plist — launchd never accepted it, so don't leave
      // a half-installed artifact on disk that could confuse later runs.
      try { await unlink(plistPath); } catch {}
      throw new Error(
        `Failed to load launchd job: bootstrap error: ${bootstrapErr.stderr || bootstrapErr.message}; ` +
        `load fallback error: ${loadErr.stderr || loadErr.message}`,
      );
    }
  }
  return { plistPath, label };
}

// macOS remove: unload the job then delete the plist. Idempotent.
async function removeLaunchd(agentName) {
  const label = `com.agent-orchestrator.${agentName}`;
  const plistPath = join(LAUNCH_AGENTS_DIR, `${label}.plist`);
  const uid = process.getuid ? process.getuid() : 0;

  let existed = false;
  try {
    await access(plistPath);
    existed = true;
  } catch {}

  // Always try to bootout in case the plist was already deleted but job still loaded
  try {
    await _execFn(`launchctl bootout gui/${uid}/${label}`);
  } catch {
    // Fallback to unload if plist exists
    if (existed) {
      try { await _execFn(`launchctl unload ${JSON.stringify(plistPath)}`); } catch {}
    }
  }

  if (existed) {
    try { await unlink(plistPath); } catch {}
  }
  return existed;
}

// Check whether the launchd plist exists for an agent.
async function launchdArtifactExists(agentName) {
  const label = `com.agent-orchestrator.${agentName}`;
  const plistPath = join(LAUNCH_AGENTS_DIR, `${label}.plist`);
  try { await access(plistPath); return true; } catch { return false; }
}

// Check whether the crontab has a marker line for this agent.
async function crontabArtifactExists(agentName) {
  const current = await readCrontab();
  return current.includes(`${CRON_MARKER_PREFIX}${agentName}`);
}

function detectSchedulerPlatform() {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  throw new Error(`Scheduling only supported on macOS and Linux (got ${process.platform})`);
}

// Top-level schedule command handler.
async function scheduleCommand(args) {
  // Sub: `schedule list`
  if (args[0] === "list") {
    await scheduleList();
    return;
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      cron: { type: "string" },
      at: { type: "string" },
      remove: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const name = positionals[0];
  if (!name) {
    throw new Error(
      `Usage:\n` +
      `  orchestrator schedule <name> --cron "<expr>"\n` +
      `  orchestrator schedule <name> --at "<sugar>"\n` +
      `  orchestrator schedule <name> --remove\n` +
      `  orchestrator schedule <name>\n` +
      `  orchestrator schedule list`,
    );
  }

  const agentDir = join(_agentsDir, name);
  if (!(await exists(agentDir))) throw new Error(`Agent "${name}" not found`);

  // Show-current mode (no install flags)
  if (!values.cron && !values.at && !values.remove) {
    await scheduleShow(name);
    return;
  }

  if (values.remove) {
    await scheduleRemove(name);
    return;
  }

  // Install path — figure out cron expression
  let cronExpr;
  if (values.cron && values.at) {
    throw new Error(`--cron and --at are mutually exclusive`);
  } else if (values.at) {
    cronExpr = expandScheduleSugar(values.at);
  } else {
    cronExpr = values.cron.trim();
  }
  validateCronExpr(cronExpr);

  await scheduleInstall(name, cronExpr, { force: values.force });
}

async function scheduleInstall(name, cronExpr, { force = false } = {}) {
  const platform = detectSchedulerPlatform();
  const agentDir = join(_agentsDir, name);
  const configPath = join(agentDir, "config.json");
  const config = await readJson(configPath);
  const existing = config.schedule || {};

  if (existing.intervalSeconds && !force) {
    throw new Error(
      `Agent "${name}" already has an interval schedule (${existing.intervalSeconds}s). ` +
      `Remove it first or pass --force to replace it with cron.`,
    );
  }

  // Platform-specific install (launchd validates plist with plutil before loading)
  if (platform === "darwin") {
    await installLaunchd(name, cronExpr);
  } else {
    await installCrontab(name, cronExpr);
  }

  const newSchedule = {
    ...(existing.intervalSeconds && !force ? { intervalSeconds: existing.intervalSeconds } : {}),
    cron: cronExpr,
    installedAt: new Date().toISOString(),
    platform,
  };
  config.schedule = newSchedule;
  await writeJson(configPath, config);

  console.log(`Scheduled "${name}" on ${platform}: ${cronExpr}`);
  if (platform === "darwin") {
    console.log(`  Plist: ${join(LAUNCH_AGENTS_DIR, `com.agent-orchestrator.${name}.plist`)}`);
  } else {
    console.log(`  Crontab marker: ${CRON_MARKER_PREFIX}${name}`);
  }
}

async function scheduleRemove(name) {
  const platform = detectSchedulerPlatform();
  const agentDir = join(_agentsDir, name);
  const configPath = join(agentDir, "config.json");
  const config = await readJson(configPath);

  let removed = false;
  if (platform === "darwin") {
    removed = await removeLaunchd(name);
  } else {
    removed = await removeCrontab(name);
  }

  // Drop cron-related keys but preserve intervalSeconds if present
  if (config.schedule) {
    const { cron, installedAt, platform: _p, intervalSeconds, ...rest } = config.schedule;
    const remaining = { ...rest };
    if (intervalSeconds != null) remaining.intervalSeconds = intervalSeconds;
    config.schedule = Object.keys(remaining).length > 0 ? remaining : null;
    await writeJson(configPath, config);
  }

  if (removed) {
    console.log(`Removed schedule for "${name}" (${platform}).`);
  } else {
    console.log(`No OS-level schedule was installed for "${name}" (${platform}) — nothing to remove.`);
  }
}

async function scheduleShow(name) {
  const platform = (() => {
    try { return detectSchedulerPlatform(); } catch { return process.platform; }
  })();
  const agentDir = join(_agentsDir, name);
  const configPath = join(agentDir, "config.json");
  const config = await readJson(configPath);
  const sched = config.schedule || {};

  console.log(`Schedule for "${name}":`);
  if (sched.cron) {
    console.log(`  Cron:         ${sched.cron}`);
    console.log(`  Platform:     ${sched.platform || "(unknown)"}`);
    console.log(`  Installed at: ${sched.installedAt || "(unknown)"}`);
  } else {
    console.log(`  Cron:         (none)`);
  }
  if (sched.intervalSeconds) {
    console.log(`  Interval:     ${sched.intervalSeconds}s (daemon loop)`);
  }

  // OS artifact check (best-effort)
  if (platform === "darwin") {
    const plistPath = join(LAUNCH_AGENTS_DIR, `com.agent-orchestrator.${name}.plist`);
    const exists = await launchdArtifactExists(name);
    console.log(`  Plist:        ${plistPath}`);
    console.log(`  Plist exists: ${exists ? "yes" : "no"}`);
  } else if (platform === "linux") {
    const exists = await crontabArtifactExists(name).catch(() => false);
    console.log(`  Crontab line: ${exists ? "present" : "absent"} (marker: ${CRON_MARKER_PREFIX}${name})`);
  }
}

async function scheduleList() {
  if (!(await exists(_agentsDir))) {
    console.log("No agents found.");
    return;
  }
  const entries = await readdir(_agentsDir, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = join(_agentsDir, entry.name, "config.json");
    try {
      const config = await readJson(configPath);
      const sched = config.schedule;
      if (!sched || !sched.cron) continue;
      rows.push({
        name: entry.name,
        platform: sched.platform || "-",
        cron: sched.cron,
        installedAt: sched.installedAt || "-",
      });
    } catch {
      // skip unreadable
    }
  }

  if (rows.length === 0) {
    console.log("No scheduled agents.");
    return;
  }

  const header = `${"NAME".padEnd(20)} ${"PLATFORM".padEnd(9)} ${"CRON".padEnd(19)} INSTALLED AT`;
  console.log(header);
  for (const r of rows) {
    console.log(`${r.name.padEnd(20)} ${r.platform.padEnd(9)} ${r.cron.padEnd(19)} ${r.installedAt}`);
  }
}

// --- CLI ---

const USAGE = `
Agent Orchestrator — Minimal always-alive agent manager

Usage:
  orchestrator create   Create a new agent
    --name <n>          Agent name (required)
    --mission "<m>"     Agent mission (required)
    --template <t>      Template: default, researcher, developer
    --model <m>         Claude model (default: sonnet)
    --max-turns <n>     Max turns per run (default: 25)
    --interval <s>      Auto-run interval in seconds (daemon mode)
    --workdir <path>    Target project directory
    --skills <s,s,...>  Comma-separated skills to symlink from ~/.claude/skills/

  orchestrator list-skills       List available skills from ~/.claude/skills/

  orchestrator run <name> [-m "<msg>"]  Run agent (new or resume session)
    --message, -m "<msg>"       Pass a task/instruction to the agent
    --fresh                     Force a new session (ignore existing)
  orchestrator continue <name> "<msg>"  Send a follow-up message to agent's session
  orchestrator eval <name>      Evaluate latest run (judge scores 1-10)
  orchestrator audit <name>     Audit agent's harness design (CLAUDE.md quality)
  orchestrator improve <name>   Show CLAUDE.md improvements from audit (dry-run)
    --apply                     Apply improvements (archives old, patches new)
  orchestrator autoresearch <name>  Automated run→eval→improve loop (Karpathy-style)
    --max-iterations <n>        Max loop iterations (default: 10)
    --cost-budget <usd>         Total USD budget (default: 5.0)
    --min-improvement <n>       Score delta to trigger improve (default: 0.2)
    --runs-per-eval <n>         Runs between eval comparisons (default: 1)
    -m "<task>"                 Task message for each run
  orchestrator compete <name>   Compete N CLAUDE.md variants, pick the winner
    --variants <n>              Number of variants (default: 3)
    -m "<task>"                 Task message for each variant
  orchestrator evolve <name>    Multi-generation genetic optimization
    --generations <n>           Number of generations (default: 5)
    --variants <n>              Variants per generation (default: 3)
    -m "<task>"                 Task message for each run
  orchestrator list             List all agents
  orchestrator dashboard        Agent overview: status, costs, evals, running agents
  orchestrator status <name>    Detailed agent status
  orchestrator logs <name>      Show latest run output
  orchestrator daemon           Start the always-alive daemon
    --max-concurrent <n>        Max parallel agents (default: 3)
  orchestrator delete <name>    Remove an agent

  orchestrator describe "<description>"  Natural-language → create + bootstrap + schedule an agent
    --yes                       Skip interactive confirmation
    --dry-run                   Print parsed spec, don't create anything
    --no-bootstrap              Skip the audit+improve bootstrap loop
    --no-schedule               Don't install OS-level schedule even if spec has one
    --max-iterations <n>        Bootstrap iterations (default: 2)
    --cost-budget <usd>         Total USD cap across all LLM calls (default: 1.0)
    --model <m>                 Override model for the created agent
  orchestrator describe list             List agents created via 'describe' (filter by createdBy)

  orchestrator schedule <name> --cron "<expr>"   Install cron-based schedule (launchd on macOS, crontab on Linux)
  orchestrator schedule <name> --at "<sugar>"    Sugar: "hourly", "daily 09:00", "weekdays 09:00", "weekly mon 09:00"
  orchestrator schedule <name> --remove          Uninstall cron schedule (idempotent)
  orchestrator schedule <name>                   Show current schedule + OS artifact status
  orchestrator schedule list                     List all agents with a cron schedule
    --force                     Allow replacing an existing intervalSeconds schedule

  orchestrator pipeline validate <name>  Validate pipeline config
  orchestrator pipeline run <name>       Run a pipeline
  orchestrator pipeline status <run-id>  Show pipeline run status

Auto-eval runs every ${EVAL_EVERY_N_RUNS} successful runs.
`;

async function main() {
  const command = process.argv[2];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    try {
      const templates = await readdir(TEMPLATES_DIR);
      // Hide meta/ — it's for internal meta-prompts, not agent templates
      const visible = templates.filter((t) => t !== "meta");
      console.log(`Available templates: ${visible.join(", ")}`);
    } catch {}
    return;
  }

  switch (command) {
    case "create": {
      const { values } = parseArgs({
        args: process.argv.slice(3),
        options: {
          name: { type: "string" },
          template: { type: "string", default: "default" },
          mission: { type: "string" },
          interval: { type: "string" },
          "max-turns": { type: "string", default: "25" },
          model: { type: "string", default: "sonnet" },
          workdir: { type: "string" },
          skills: { type: "string" },
          "sub-model": { type: "string", default: "sonnet" },
          "sub-max-turns": { type: "string", default: "100" },
          workflow: { type: "string" },
        },
      });
      const skillsList = values.skills
        ? values.skills.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      await createAgent({
        name: values.name,
        template: values.template,
        mission: values.mission,
        interval: values.interval,
        maxTurns: parseInt(values["max-turns"]),
        model: values.model,
        workdir: values.workdir,
        skills: skillsList,
        subModel: values["sub-model"],
        subMaxTurns: parseInt(values["sub-max-turns"]),
        workflow: values.workflow || "",
      });
      break;
    }

    case "run": {
      const { values, positionals } = parseArgs({
        args: process.argv.slice(3),
        options: {
          message: { type: "string", short: "m" },
          fresh: { type: "boolean", default: false },
        },
        allowPositionals: true,
      });
      const name = positionals[0];
      if (!name) throw new Error("Usage: orchestrator run <name> [-m '<message>'] [--fresh]");
      await runAgent(name, {
        verbose: true,
        message: values.message || null,
        fresh: values.fresh,
      });
      break;
    }

    case "continue": {
      const name = process.argv[3];
      const msg = process.argv.slice(4).join(" ");
      if (!name || !msg) throw new Error('Usage: orchestrator continue <name> "<message>"');
      // Continue always resumes existing session with new message
      const agentDir = join(_agentsDir, name);
      const state = await readJson(join(agentDir, "state.json"));
      if (!state.sessionId) {
        throw new Error(`Agent "${name}" has no active session. Use 'run' first.`);
      }
      await runAgent(name, { verbose: true, message: msg });
      break;
    }

    case "list":
      await listAgents();
      break;

    case "dashboard":
      await showDashboard();
      break;

    case "list-skills": {
      const skills = await discoverSkills();
      if (skills.length === 0) {
        console.log(`No skills found in ${USER_SKILLS_DIR}`);
      } else {
        console.log(`\nAvailable skills (${USER_SKILLS_DIR}):\n`);
        for (const s of skills) {
          console.log(`  ${pad(s.name, 28)} ${s.description || ""}`);
        }
        console.log(`\nUse --skills "name1,name2" with 'create' to link skills to an agent.\n`);
      }
      break;
    }

    case "status": {
      const name = process.argv[3];
      if (!name) throw new Error("Usage: orchestrator status <name>");
      await showStatus(name);
      break;
    }

    case "eval": {
      const name = process.argv[3];
      if (!name) throw new Error("Usage: orchestrator eval <name>");
      await evalAgent(name, { verbose: true });
      break;
    }

    case "audit": {
      const name = process.argv[3];
      if (!name) throw new Error("Usage: orchestrator audit <name>");
      await auditAgent(name);
      break;
    }

    case "improve": {
      const { values, positionals } = parseArgs({
        args: process.argv.slice(3),
        options: {
          apply: { type: "boolean", default: false },
        },
        allowPositionals: true,
      });
      const name = positionals[0];
      if (!name) throw new Error("Usage: orchestrator improve <name> [--apply]");
      await improveAgent(name, { apply: values.apply });
      break;
    }

    case "autoresearch": {
      const { values, positionals } = parseArgs({
        args: process.argv.slice(3),
        options: {
          "max-iterations": { type: "string", default: "10" },
          "cost-budget": { type: "string", default: "5.0" },
          "min-improvement": { type: "string", default: "0.2" },
          message: { type: "string", short: "m" },
          "runs-per-eval": { type: "string", default: "1" },
        },
        allowPositionals: true,
      });
      const name = positionals[0];
      if (!name) throw new Error("Usage: orchestrator autoresearch <name> [--max-iterations N] [--cost-budget USD] [--min-improvement N] [-m \"task\"] [--runs-per-eval N]");
      const maxIter = parseInt(values["max-iterations"]);
      const costBdg = parseFloat(values["cost-budget"]);
      const minImp = parseFloat(values["min-improvement"]);
      const rpe = parseInt(values["runs-per-eval"]);
      if (isNaN(maxIter) || maxIter < 1) throw new Error("--max-iterations must be a positive integer");
      if (isNaN(costBdg) || costBdg <= 0) throw new Error("--cost-budget must be a positive number");
      if (isNaN(minImp) || minImp < 0) throw new Error("--min-improvement must be non-negative");
      if (isNaN(rpe) || rpe < 1) throw new Error("--runs-per-eval must be a positive integer");
      await autoresearchAgent(name, {
        maxIterations: maxIter,
        costBudget: costBdg,
        minImprovement: minImp,
        message: values.message || null,
        runsPerEval: rpe,
      });
      break;
    }

    case "compete": {
      const { values, positionals } = parseArgs({
        args: process.argv.slice(3),
        options: {
          variants: { type: "string", default: "3" },
          message: { type: "string", short: "m" },
        },
        allowPositionals: true,
      });
      const name = positionals[0];
      if (!name) throw new Error("Usage: orchestrator compete <name> [--variants N] [-m \"task\"]");
      await competeAgent(name, {
        variants: parseInt(values.variants),
        message: values.message || null,
      });
      break;
    }

    case "evolve": {
      const { values, positionals } = parseArgs({
        args: process.argv.slice(3),
        options: {
          generations: { type: "string", default: "5" },
          variants: { type: "string", default: "3" },
          message: { type: "string", short: "m" },
        },
        allowPositionals: true,
      });
      const name = positionals[0];
      if (!name) throw new Error("Usage: orchestrator evolve <name> [--generations N] [--variants N] [-m \"task\"]");
      await evolveAgent(name, {
        generations: parseInt(values.generations),
        variants: parseInt(values.variants),
        message: values.message || null,
      });
      break;
    }

    case "logs": {
      const name = process.argv[3];
      if (!name) throw new Error("Usage: orchestrator logs <name>");
      await showLogs(name);
      break;
    }

    case "daemon": {
      const { values } = parseArgs({
        args: process.argv.slice(3),
        options: {
          "max-concurrent": { type: "string", default: "3" },
        },
      });
      await startDaemon({
        maxConcurrent: parseInt(values["max-concurrent"]),
      });
      break;
    }

    case "delete": {
      const name = process.argv[3];
      if (!name) throw new Error("Usage: orchestrator delete <name>");
      const agentDir = join(_agentsDir, name);
      if (!(await exists(agentDir)))
        throw new Error(`Agent "${name}" not found`);
      const config = await readAgentConfig(agentDir);
      console.log(`Deleting agent "${name}" (${config.mission})...`);
      await rm(agentDir, { recursive: true });
      console.log(`Agent "${name}" deleted.`);
      break;
    }

    case "schedule": {
      await scheduleCommand(process.argv.slice(3));
      break;
    }

    case "describe": {
      // Sub: `describe list` → list only describe-generated agents
      if (process.argv[3] === "list") {
        await describeList();
        break;
      }
      const { values, positionals } = parseArgs({
        args: process.argv.slice(3),
        options: {
          yes: { type: "boolean", default: false },
          "dry-run": { type: "boolean", default: false },
          "no-bootstrap": { type: "boolean", default: false },
          "no-schedule": { type: "boolean", default: false },
          "max-iterations": { type: "string", default: "2" },
          "cost-budget": { type: "string", default: "1.0" },
          model: { type: "string" },
        },
        allowPositionals: true,
      });
      const description = positionals.join(" ").trim();
      if (!description) {
        throw new Error(
          `Usage: orchestrator describe "<description>" [--yes] [--dry-run] [--no-bootstrap] [--no-schedule] [--max-iterations N] [--cost-budget USD] [--model m]\n       orchestrator describe list`,
        );
      }
      const maxIter = parseInt(values["max-iterations"]);
      const costBdg = parseFloat(values["cost-budget"]);
      if (!Number.isInteger(maxIter) || maxIter < 1) {
        throw new Error(`--max-iterations must be a positive integer`);
      }
      if (!(costBdg > 0)) {
        throw new Error(`--cost-budget must be a positive number`);
      }
      await describeAgent(description, {
        yes: values.yes,
        dryRun: values["dry-run"],
        noBootstrap: values["no-bootstrap"],
        noSchedule: values["no-schedule"],
        maxIterations: maxIter,
        costBudget: costBdg,
        model: values.model || null,
      });
      break;
    }

    case "pipeline": {
      const subcommand = process.argv[3];
      const pipelineName = process.argv[4];
      switch (subcommand) {
        case "validate": {
          if (!pipelineName) {
            console.error("Usage: orchestrator pipeline validate <name>");
            process.exit(1);
          }
          await validatePipeline(pipelineName);
          break;
        }
        case "run": {
          if (!pipelineName) {
            console.error("Usage: orchestrator pipeline run <name>");
            process.exit(1);
          }
          await runPipeline(pipelineName);
          break;
        }
        case "status": {
          const runId = process.argv[4];
          await showPipelineStatus(runId);
          break;
        }
        case "list": {
          await listPipelineRuns();
          break;
        }
        default: {
          console.error(`Unknown pipeline subcommand: ${subcommand}`);
          console.log("Usage:");
          console.log("  orchestrator pipeline validate <name>  Validate pipeline config");
          console.log("  orchestrator pipeline run <name>       Run a pipeline");
          console.log("  orchestrator pipeline status <run-id>  Show pipeline run status");
          console.log("  orchestrator pipeline list             List all pipeline runs");
          process.exit(1);
        }
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
