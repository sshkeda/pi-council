#!/usr/bin/env node

/**
 * Unit tests for runs.ts and storage.ts — filesystem-backed run management.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-runs-test-"));
process.env.HOME = testHome;

const { getCouncilHomeDir, getRunsDir, getRunDir, getLatestRunIdPath, setLatestRunId, getLatestRunId } =
  await import("../dist/src/core/storage.js");
const { listRuns, resolveRunId, readRunMeta, readRunResults, cleanupRun } =
  await import("../dist/src/core/runs.js");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`  ❌ ${name}: ${err.message}\n`);
  }
}

process.stdout.write("\n🧪 Runs & Storage Test Suite\n\n");

process.stdout.write("── Storage Tests ──\n");

await test("S1: getCouncilHomeDir returns ~/.pi-council", async () => {
  assert(getCouncilHomeDir() === path.join(testHome, ".pi-council"), "correct path");
});

await test("S2: getRunsDir returns ~/.pi-council/runs", async () => {
  assert(getRunsDir() === path.join(testHome, ".pi-council", "runs"), "correct path");
});

await test("S3: getRunDir returns correct run directory", async () => {
  assert(getRunDir("abc123") === path.join(testHome, ".pi-council", "runs", "abc123"), "correct path");
});

await test("S4: setLatestRunId writes and getLatestRunId reads back", async () => {
  setLatestRunId("run-001");
  assert(getLatestRunId() === "run-001", "reads back same id");
});

await test("S5: setLatestRunId creates directory structure", async () => {
  assert(fs.existsSync(getLatestRunIdPath()), "file exists");
  assert(fs.existsSync(path.dirname(getLatestRunIdPath())), "parent dir exists");
});

await test("S6: getLatestRunId falls back to directory scan", async () => {
  fs.unlinkSync(getLatestRunIdPath());

  const runsDir = getRunsDir();
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(path.join(runsDir, "20260101-aaa"), { recursive: true });
  fs.mkdirSync(path.join(runsDir, "20260102-bbb"), { recursive: true });

  const latest = getLatestRunId();
  assert(latest === "20260102-bbb", `falls back to newest dir: ${latest}`);

  fs.rmSync(path.join(runsDir, "20260101-aaa"), { recursive: true });
  fs.rmSync(path.join(runsDir, "20260102-bbb"), { recursive: true });
});

await test("S7: getLatestRunId returns undefined when no runs exist", async () => {
  try { fs.unlinkSync(getLatestRunIdPath()); } catch {}
  const runsDir = getRunsDir();
  for (const d of fs.readdirSync(runsDir)) {
    fs.rmSync(path.join(runsDir, d), { recursive: true });
  }
  assert(getLatestRunId() === undefined, "undefined when empty");
});

process.stdout.write("\n── Runs Tests ──\n");

function createFakeRun(runId, { meta, results } = {}) {
  const runDir = getRunDir(runId);
  fs.mkdirSync(runDir, { recursive: true });
  if (meta) {
    fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta));
  }
  if (results) {
    fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(results));
  }
}

await test("R1: listRuns returns empty when no runs directory", async () => {
  const runsDir = getRunsDir();
  for (const d of fs.readdirSync(runsDir)) {
    fs.rmSync(path.join(runsDir, d), { recursive: true });
  }
  fs.rmdirSync(runsDir);
  assert(listRuns().length === 0, "empty list");
  fs.mkdirSync(runsDir, { recursive: true });
});

await test("R2: listRuns returns runs sorted newest first", async () => {
  createFakeRun("20260101-aaa", {
    meta: { prompt: "first", models: [{ id: "claude" }], startedAt: 1000 },
  });
  createFakeRun("20260102-bbb", {
    meta: { prompt: "second", models: [{ id: "gpt" }], startedAt: 2000 },
    results: { completedAt: 3000, ttfrMs: 500 },
  });

  const runs = listRuns();
  assert(runs.length === 2, `2 runs: ${runs.length}`);
  assert(runs[0].runId === "20260102-bbb", "newest first");
  assert(runs[1].runId === "20260101-aaa", "oldest second");
});

await test("R3: listRuns populates status from results.json presence", async () => {
  const runs = listRuns();
  const complete = runs.find(r => r.runId === "20260102-bbb");
  const running = runs.find(r => r.runId === "20260101-aaa");
  assert(complete.status === "complete", "has results = complete");
  assert(running.status === "running", "no results = running");
});

await test("R4: listRuns populates meta fields", async () => {
  const runs = listRuns();
  const run = runs.find(r => r.runId === "20260102-bbb");
  assert(run.prompt === "second", `prompt: ${run.prompt}`);
  assert(run.models.length === 1, "1 model");
  assert(run.models[0] === "gpt", `model: ${run.models[0]}`);
  assert(run.startedAt === 2000, `startedAt: ${run.startedAt}`);
  assert(run.completedAt === 3000, `completedAt: ${run.completedAt}`);
  assert(run.ttfrMs === 500, `ttfrMs: ${run.ttfrMs}`);
});

await test("R5: resolveRunId uses provided id", async () => {
  assert(resolveRunId("explicit-id") === "explicit-id", "uses explicit");
});

await test("R6: resolveRunId falls back to latest", async () => {
  setLatestRunId("20260102-bbb");
  assert(resolveRunId() === "20260102-bbb", "uses latest");
});

await test("R7: readRunMeta returns meta for existing run", async () => {
  const meta = readRunMeta("20260102-bbb");
  assert(meta !== undefined, "not undefined");
  assert(meta.prompt === "second", `prompt: ${meta.prompt}`);
});

await test("R8: readRunMeta returns undefined for missing run", async () => {
  assert(readRunMeta("nonexistent") === undefined, "undefined");
});

await test("R9: readRunResults returns results for completed run", async () => {
  const results = readRunResults("20260102-bbb");
  assert(results !== undefined, "not undefined");
  assert(results.completedAt === 3000, `completedAt: ${results.completedAt}`);
});

await test("R10: readRunResults returns undefined for running run", async () => {
  assert(readRunResults("20260101-aaa") === undefined, "undefined for running");
});

await test("R11: cleanupRun removes a specific run", async () => {
  createFakeRun("20260103-cleanup", {
    meta: { prompt: "cleanup me" },
  });
  assert(fs.existsSync(getRunDir("20260103-cleanup")), "exists before cleanup");

  const result = cleanupRun("20260103-cleanup");
  assert(result.removed.length === 1, "1 removed");
  assert(result.removed[0] === "20260103-cleanup", "correct id");
  assert(!fs.existsSync(getRunDir("20260103-cleanup")), "gone after cleanup");
});

await test("R12: cleanupRun with --all removes everything", async () => {
  createFakeRun("20260104-all1", { meta: { prompt: "a" } });
  createFakeRun("20260105-all2", { meta: { prompt: "b" } });

  const result = cleanupRun("--all");
  assert(result.removed.length >= 2, `removed ${result.removed.length} runs`);
  assert(fs.readdirSync(getRunsDir()).length === 0, "runs dir empty");
});

await test("R13: cleanupRun on nonexistent run returns empty", async () => {
  const result = cleanupRun("nonexistent-id");
  assert(result.removed.length === 0, "nothing removed");
});

await test("R14: readRunMeta resolves via latest when no id given", async () => {
  createFakeRun("20260106-latest", {
    meta: { prompt: "latest run" },
  });
  setLatestRunId("20260106-latest");

  const meta = readRunMeta();
  assert(meta !== undefined, "resolved via latest");
  assert(meta.prompt === "latest run", `prompt: ${meta.prompt}`);

  cleanupRun("--all");
});

// Cleanup
fs.rmSync(testHome, { recursive: true, force: true });

process.stdout.write(`\n📊 Runs & Storage: ${passed} passed, ${failed} failed out of ${passed + failed}\n\n`);
process.stdout.write(`METRIC runs_storage_passed=${passed}\n`);
process.stdout.write(`METRIC runs_storage_failed=${failed}\n`);

if (failed > 0) process.exit(1);
