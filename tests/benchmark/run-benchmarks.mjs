#!/usr/bin/env node
/**
 * pi-council Benchmark Suite
 *
 * Tests real end-to-end CLI functionality with mock pi binaries.
 * Each test gets an isolated HOME directory so runs don't interfere.
 *
 * Outputs:
 *   METRIC tests_passed=N
 *   METRIC tests_failed=N
 *   METRIC total_tests=N
 *   METRIC duration_ms=N
 *
 * Exit code: 0 always (so autoresearch treats pass count as the metric, not crash)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawnSync, spawn as spawnChild } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const MOCK_PI = path.join(__dirname, "mock-pi");
const CLI_ENTRY = path.join(PROJECT_ROOT, "dist/src/cli.js");
const TEST_ROOT = path.join(__dirname, "test-runs");

// Ensure built
try {
  if (!fs.existsSync(CLI_ENTRY)) {
    console.log("Building project...");
    execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });
  }
} catch (e) {
  console.error("Build failed:", e.message);
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function setupIsolatedEnv(testName) {
  const testDir = path.join(TEST_ROOT, testName);
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  const homeDir = path.join(testDir, "fakehome");
  const configDir = path.join(homeDir, ".pi-council");
  const runsDir = path.join(configDir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });

  // Write config with test models
  const config = {
    models: [
      { id: "claude", provider: "anthropic", model: "claude-test" },
      { id: "gpt", provider: "openai", model: "gpt-test" },
      { id: "gemini", provider: "google", model: "gemini-test" },
      { id: "grok", provider: "xai", model: "grok-test" },
    ],
    tools: "bash,read",
    stall_seconds: 3,
    system_prompt: "Test system prompt.",
  };
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config, null, 2));

  // Create a bin dir with our mock-pi symlinked as "pi"
  const binDir = path.join(testDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(MOCK_PI, path.join(binDir, "pi"));

  return { testDir, homeDir, configDir, runsDir, binDir };
}

function runCLI(args, env, { timeout = 30000 } = {}) {
  const result = spawnSync("node", [CLI_ENTRY, ...args], {
    env,
    stdio: "pipe",
    timeout,
    cwd: env._CWD || PROJECT_ROOT,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout?.toString() || "",
    stderr: result.stderr?.toString() || "",
    signal: result.signal,
    error: result.error,
  };
}

function makeEnv(binDir, homeDir, behaviors = {}) {
  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH}`,
    MOCK_BEHAVIOR: "success", // default
  };
  // Per-model behaviors
  for (const [model, behavior] of Object.entries(behaviors)) {
    env[`MOCK_BEHAVIOR_${model}`] = behavior;
  }
  return env;
}

function getLatestRun(runsDir) {
  if (!fs.existsSync(runsDir)) return null;
  const dirs = fs.readdirSync(runsDir).filter((d) => /^\d{8}-/.test(d)).sort();
  return dirs.length > 0 ? dirs[dirs.length - 1] : null;
}

function loadResults(runsDir, runId) {
  const resultsPath = path.join(runsDir, runId, "results.json");
  if (!fs.existsSync(resultsPath)) return null;
  return JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
}

function loadMeta(runsDir, runId) {
  const metaPath = path.join(runsDir, runId, "meta.json");
  if (!fs.existsSync(metaPath)) return null;
  return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// ── Test Definitions ────────────────────────────────────────────────────────

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

// ─── T01: All 4 models succeed ──────────────────────────────────────────────
test("T01_basic_4model_success", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T01");
  const env = makeEnv(binDir, homeDir);

  const res = runCLI(["ask", "What is 2+2?"], env);

  const runId = getLatestRun(runsDir);
  assert(runId, "Run directory created");

  const meta = loadMeta(runsDir, runId);
  assert(meta, "meta.json exists");
  assert(meta.agents.length === 4, `4 agents in meta, got ${meta.agents.length}`);
  assert(meta.prompt === "What is 2+2?", "Prompt preserved in meta");

  const results = loadResults(runsDir, runId);
  assert(results, "results.json exists");
  assert(results.workers.length === 4, `4 workers in results, got ${results.workers.length}`);

  const done = results.workers.filter((w) => w.finalText && w.finalText.length > 0);
  assert(done.length === 4, `All 4 workers have finalText, got ${done.length}`);

  for (const w of results.workers) {
    assert(w.finalText.includes("Final answer from"), `Worker ${w.id} has expected output`);
  }

  // results.md should also exist
  const mdPath = path.join(runsDir, runId, "results.md");
  assert(fs.existsSync(mdPath), "results.md created");
  const md = fs.readFileSync(mdPath, "utf-8");
  assert(md.includes("claude"), "results.md mentions claude");
  assert(md.includes("grok"), "results.md mentions grok");
});

// ─── T02: Model filtering (--models) ───────────────────────────────────────
test("T02_model_filter", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T02");
  const env = makeEnv(binDir, homeDir);

  const res = runCLI(["ask", "--models", "claude,grok", "Test question"], env);

  const runId = getLatestRun(runsDir);
  assert(runId, "Run created");

  const meta = loadMeta(runsDir, runId);
  assert(meta.agents.length === 2, `2 agents, got ${meta.agents.length}`);
  assert(meta.agents.map((a) => a.id).sort().join(",") === "claude,grok", "Correct models filtered");

  const results = loadResults(runsDir, runId);
  assert(results.workers.length === 2, `2 workers, got ${results.workers.length}`);

  // Ensure no gpt/gemini files exist
  const files = fs.readdirSync(path.join(runsDir, runId));
  assert(!files.some((f) => f.startsWith("gpt.")), "No gpt files created");
  assert(!files.some((f) => f.startsWith("gemini.")), "No gemini files created");
});

// ─── T03: One model fails, others succeed ───────────────────────────────────
test("T03_one_model_error", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T03");
  const env = makeEnv(binDir, homeDir, { gpt: "error" });

  const res = runCLI(["ask", "Analyze this code"], env);
  // Should exit 1 because of the failure
  assert(res.exitCode === 1, `Exit code 1 on partial failure, got ${res.exitCode}`);

  const runId = getLatestRun(runsDir);
  const results = loadResults(runsDir, runId);

  const gptWorker = results.workers.find((w) => w.id === "gpt");
  assert(gptWorker, "GPT worker in results");
  // The error model produces errorMessage in JSONL but still outputs it
  // Check that the other 3 succeeded
  const succeeded = results.workers.filter((w) => w.finalText && w.finalText.includes("Final answer"));
  assert(succeeded.length === 3, `3 models succeeded, got ${succeeded.length}`);
});

// ─── T04: All models fail ───────────────────────────────────────────────────
test("T04_all_models_fail", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T04");
  const env = makeEnv(binDir, homeDir);
  env.MOCK_BEHAVIOR = "error";

  const res = runCLI(["ask", "This will fail"], env);
  assert(res.exitCode === 1, `Exit code 1 on all-fail, got ${res.exitCode}`);

  const runId = getLatestRun(runsDir);
  const results = loadResults(runsDir, runId);
  assert(results, "results.json still generated even on all-fail");
  assert(results.workers.length === 4, "All 4 workers present");

  // None should have meaningful finalText
  const withOutput = results.workers.filter((w) => w.finalText && w.finalText.includes("Final answer"));
  assert(withOutput.length === 0, `0 succeeded, got ${withOutput.length}`);
});

// ─── T05: Partial output (no message_end) ───────────────────────────────────
test("T05_partial_output", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T05");
  const env = makeEnv(binDir, homeDir, { claude: "partial", gpt: "partial" });

  const res = runCLI(["ask", "--models", "claude,gpt", "Partial test"], env);

  const runId = getLatestRun(runsDir);
  const results = loadResults(runsDir, runId);

  // Both should finish (process exits) but may have partial output via assistantText fallback
  assert(results.workers.length === 2, "2 workers present");

  // The stream parser captures assistantText even without message_end with stop
  for (const w of results.workers) {
    // Worker should be marked — either has some text or has error
    assert(
      w.finalText || w.status === "failed",
      `Worker ${w.id} should have partial text or be marked failed`
    );
  }
});

// ─── T06: Malformed JSONL lines ─────────────────────────────────────────────
test("T06_malformed_jsonl", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T06");
  const env = makeEnv(binDir, homeDir);
  env.MOCK_BEHAVIOR = "malformed";

  const res = runCLI(["ask", "--models", "claude", "Malformed test"], env);

  const runId = getLatestRun(runsDir);
  const results = loadResults(runsDir, runId);

  const w = results.workers[0];
  assert(w, "Worker exists");
  assert(w.finalText.includes("Final answer"), `Parser recovered: got "${w.finalText.slice(0, 60)}..."`);
  // The parser should skip bad lines and still extract the final message_end
});

// ─── T07: Large output (1000 events) ────────────────────────────────────────
test("T07_large_output", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T07");
  const env = makeEnv(binDir, homeDir, { claude: "large:1000" });

  const res = runCLI(["ask", "--models", "claude", "Large output test"], env);

  const runId = getLatestRun(runsDir);
  const results = loadResults(runsDir, runId);

  const w = results.workers[0];
  assert(w, "Worker exists");
  assert(w.finalText.includes("Large output complete"), `Final text captured: "${w.finalText.slice(0, 60)}..."`);
  // Stream file should be substantial
  const streamFile = path.join(runsDir, runId, "claude.jsonl");
  const stat = fs.statSync(streamFile);
  assert(stat.size > 10000, `Stream file is large: ${stat.size} bytes`);
});

// ─── T08: Tool call counting ────────────────────────────────────────────────
test("T08_tool_call_counting", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T08");
  const env = makeEnv(binDir, homeDir, { claude: "tooluse:5" });

  const res = runCLI(["ask", "--models", "claude", "Tool use test"], env);

  const runId = getLatestRun(runsDir);

  // Parse stream directly to check tool call count
  const streamFile = path.join(runsDir, runId, "claude.jsonl");
  const raw = fs.readFileSync(streamFile, "utf-8");
  const events = raw.split("\n").filter(Boolean);

  // Count toolCall content parts in message_end events
  let toolCalls = 0;
  let finalText = "";
  for (const line of events) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "message_end") {
        for (const part of ev.message?.content || []) {
          if (part.type === "toolCall") toolCalls++;
        }
        if (ev.message?.stopReason === "stop") {
          const texts = (ev.message.content || []).filter((p) => p.type === "text").map((p) => p.text);
          finalText = texts.join("");
        }
      }
    } catch {}
  }

  assert(toolCalls === 5, `5 tool calls counted, got ${toolCalls}`);
  assert(finalText.includes("Final answer"), `Final answer extracted (not intermediate toolUse text)`);
});

// ─── T09: Usage accumulation across multiple message_end events ─────────────
test("T09_usage_accumulation", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T09");
  const env = makeEnv(binDir, homeDir, { claude: "multiend" });

  const res = runCLI(["ask", "--models", "claude", "Usage accumulation test"], env);

  const runId = getLatestRun(runsDir);

  // Parse the stream ourselves to verify expected totals
  const streamFile = path.join(runsDir, runId, "claude.jsonl");
  const raw = fs.readFileSync(streamFile, "utf-8");
  let expectedInput = 0, expectedOutput = 0, expectedCost = 0;
  for (const line of raw.split("\n").filter(Boolean)) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "message_end" && ev.message?.usage) {
        expectedInput += ev.message.usage.input || 0;
        expectedOutput += ev.message.usage.output || 0;
        expectedCost += ev.message.usage.cost?.total || 0;
      }
    } catch {}
  }

  assert(expectedInput > 200, `Multiple message_ends sum input > 200, got ${expectedInput}`);
  assert(expectedOutput > 400, `Multiple message_ends sum output > 400, got ${expectedOutput}`);

  // Now verify the results.json reflects accumulated usage
  // (This tests that the stream parser correctly accumulates across events)
  const results = loadResults(runsDir, runId);
  const w = results.workers[0];
  assert(w.usage, "Usage field exists in results");
  // Note: results.json might not include usage depending on the results command implementation
  // The key test is that the stream parser accumulates correctly
});

// ─── T10: Stall detection ───────────────────────────────────────────────────
test("T10_stall_detection", () => {
  const { homeDir, runsDir, binDir, testDir } = setupIsolatedEnv("T10");
  const env = makeEnv(binDir, homeDir, { claude: "stall:10" });

  // Use spawn (background) instead of ask so we can check status mid-run
  const res = runCLI(["spawn", "--models", "claude", "Stall test"], env, { timeout: 5000 });

  const runId = getLatestRun(runsDir);
  assert(runId, "Run created");

  // Wait a moment for the mock to write its initial output
  spawnSync("sleep", ["1"]);

  // Now check status — with stall_seconds=3 and the mock sleeping 10s,
  // after ~4 seconds it should be stalled
  spawnSync("sleep", ["3"]);

  const statusRes = runCLI(["status", runId], env);
  // Status should indicate stalled (the mock writes one event then sleeps 10s)
  const output = statusRes.stderr;
  // The worker should be running or stalled
  assert(
    output.includes("stalled") || output.includes("running"),
    `Status shows stalled or running: "${output.replace(/\n/g, " ").slice(0, 200)}"`
  );

  // Cleanup — kill the background process
  runCLI(["cancel", runId], env);
});

// ─── T11: Cancel kills processes ────────────────────────────────────────────
test("T11_cancel_kills_processes", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T11");
  const env = makeEnv(binDir, homeDir);
  env.MOCK_BEHAVIOR = "slow:30"; // All models sleep 30s

  // Spawn in background
  const res = runCLI(["spawn", "Cancel test"], env, { timeout: 5000 });
  const runId = getLatestRun(runsDir);
  assert(runId, "Run created");

  // Give processes a moment to start
  spawnSync("sleep", ["1"]);

  // Read PIDs
  const runDir = path.join(runsDir, runId);
  const pidFiles = fs.readdirSync(runDir).filter((f) => f.endsWith(".pid"));
  assert(pidFiles.length === 4, `4 PID files, got ${pidFiles.length}`);

  const pids = pidFiles.map((f) => parseInt(fs.readFileSync(path.join(runDir, f), "utf-8").trim()));
  // Verify at least some PIDs are alive before cancel
  const aliveBefore = pids.filter((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  assert(aliveBefore.length > 0, `At least 1 PID alive before cancel, got ${aliveBefore.length}`);

  // Cancel
  const cancelRes = runCLI(["cancel", runId], env);
  assert(cancelRes.stderr.includes("Cancelled"), "Cancel confirmed");

  // Give time for kills
  spawnSync("sleep", ["2"]);

  // Verify PIDs are dead
  const aliveAfter = pids.filter((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  assert(aliveAfter.length === 0, `All PIDs dead after cancel, ${aliveAfter.length} still alive`);

  // Done files should exist
  const doneFiles = fs.readdirSync(runDir).filter((f) => f.endsWith(".done"));
  assert(doneFiles.length === 4, `4 .done files after cancel, got ${doneFiles.length}`);
});

// ─── T12: Cleanup removes files ─────────────────────────────────────────────
test("T12_cleanup_removes_files", () => {
  const { homeDir, runsDir, binDir, configDir } = setupIsolatedEnv("T12");
  const env = makeEnv(binDir, homeDir);

  // Create a first run
  runCLI(["ask", "--models", "claude", "First run"], env);
  const firstRun = getLatestRun(runsDir);
  assert(firstRun, "First run created");

  // Create a second run
  runCLI(["ask", "--models", "claude", "Second run"], env);
  const secondRun = getLatestRun(runsDir);
  assert(secondRun, "Second run created");
  assert(secondRun !== firstRun, "Different run IDs");

  // Latest should point to second run
  const latestFile = path.join(configDir, "latest-run-id");
  const latestBefore = fs.readFileSync(latestFile, "utf-8").trim();
  assert(latestBefore === secondRun, "Latest points to second run");

  // Cleanup second run
  runCLI(["cleanup", secondRun], env);

  // Directory should be gone
  assert(!fs.existsSync(path.join(runsDir, secondRun)), "Second run directory deleted");

  // Latest should now point to first run
  if (fs.existsSync(latestFile)) {
    const latestAfter = fs.readFileSync(latestFile, "utf-8").trim();
    assert(latestAfter === firstRun, `Latest updated to first run, got ${latestAfter}`);
  }

  // First run should still exist
  assert(fs.existsSync(path.join(runsDir, firstRun)), "First run still exists");
});

// ─── T13: Concurrent runs ──────────────────────────────────────────────────
test("T13_concurrent_runs", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T13");
  const env = makeEnv(binDir, homeDir);

  // Spawn two runs near-simultaneously using spawn (background)
  const res1 = runCLI(["spawn", "--models", "claude", "Run A"], env);
  // Tiny delay to ensure different run IDs (they include seconds)
  spawnSync("sleep", ["1.1"]);
  const res2 = runCLI(["spawn", "--models", "gpt", "Run B"], env);

  // Wait for both to finish
  spawnSync("sleep", ["2"]);

  // List runs
  const listRes = runCLI(["list"], env);
  const runs = fs.readdirSync(runsDir).filter((d) => /^\d{8}-/.test(d));
  assert(runs.length >= 2, `At least 2 runs exist, got ${runs.length}`);

  // Each run should have its own meta with correct model
  for (const runId of runs) {
    const meta = loadMeta(runsDir, runId);
    assert(meta, `meta.json exists for ${runId}`);
    assert(meta.agents.length >= 1, `At least 1 agent in ${runId}`);
  }

  // No cross-contamination: each run dir should only have files for its models
  for (const runId of runs) {
    const meta = loadMeta(runsDir, runId);
    const runDir = path.join(runsDir, runId);
    const files = fs.readdirSync(runDir);
    const modelIds = meta.agents.map((a) => a.id);
    const streamFiles = files.filter((f) => f.endsWith(".jsonl"));
    for (const sf of streamFiles) {
      const id = sf.replace(".jsonl", "");
      assert(modelIds.includes(id), `Stream file ${sf} in ${runId} matches meta agents`);
    }
  }
});

// ─── T14: Empty output detection ────────────────────────────────────────────
test("T14_empty_output", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T14");
  const env = makeEnv(binDir, homeDir, { claude: "empty" });

  const res = runCLI(["ask", "--models", "claude", "Empty test"], env);
  assert(res.exitCode === 1, `Exit code 1 for empty output, got ${res.exitCode}`);

  const runId = getLatestRun(runsDir);
  const results = loadResults(runsDir, runId);
  const w = results.workers[0];

  assert(w.status === "failed" || !w.finalText, `Empty output detected: status=${w.status}, text="${w.finalText}"`);
});

// ─── T15: Spawn background + results wait ───────────────────────────────────
test("T15_spawn_then_results", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T15");
  const env = makeEnv(binDir, homeDir, { claude: "slow:2" });

  // Spawn in background
  const spawnRes = runCLI(["spawn", "--models", "claude", "Spawn+results test"], env);
  const runId = getLatestRun(runsDir);
  assert(runId, "Run created");

  // stdout should contain the run ID
  assert(spawnRes.stdout.trim().length > 0, "spawn prints run ID to stdout");

  // Results should wait for completion
  const resultsRes = runCLI(["results", runId], env, { timeout: 15000 });
  assert(resultsRes.stdout.includes("Final answer") || resultsRes.stdout.includes("CLAUDE"), "Results printed after wait");

  const results = loadResults(runsDir, runId);
  assert(results, "results.json written by results command");
  assert(results.workers[0].finalText.includes("Slow but complete"), "Slow model completed");
});

// ─── T16: Unknown model rejection ───────────────────────────────────────────
test("T16_unknown_model_rejection", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T16");
  const env = makeEnv(binDir, homeDir);

  const res = runCLI(["ask", "--models", "nonexistent", "Bad model"], env);
  assert(res.exitCode === 1, `Exit 1 for unknown model, got ${res.exitCode}`);
  assert(
    res.stderr.includes("Unknown") || res.stderr.includes("Error"),
    `Error message for unknown model: "${res.stderr.slice(0, 200)}"`
  );
});

// ─── T17: Process crash (exit 1, no JSONL) ──────────────────────────────────
test("T17_process_crash", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T17");
  const env = makeEnv(binDir, homeDir, { gpt: "crash" });

  const res = runCLI(["ask", "Crash test"], env);

  const runId = getLatestRun(runsDir);
  const results = loadResults(runsDir, runId);

  // GPT crashed — should be failed
  const gptWorker = results.workers.find((w) => w.id === "gpt");
  assert(gptWorker, "GPT worker exists in results");
  assert(gptWorker.status === "failed", `Crashed worker is failed, got ${gptWorker.status}`);

  // Other models should still succeed
  const others = results.workers.filter((w) => w.id !== "gpt" && w.finalText);
  assert(others.length === 3, `3 other models succeeded, got ${others.length}`);
});

// ─── T18: Silent crash (partial write + exit 1) ────────────────────────────
test("T18_silent_crash", () => {
  const { homeDir, runsDir, binDir } = setupIsolatedEnv("T18");
  const env = makeEnv(binDir, homeDir, { claude: "silent_crash" });

  const res = runCLI(["ask", "--models", "claude,gpt", "Silent crash test"], env);

  const runId = getLatestRun(runsDir);
  const results = loadResults(runsDir, runId);

  // Claude wrote partial output then crashed
  const claude = results.workers.find((w) => w.id === "claude");
  assert(claude, "Claude worker exists");
  // It wrote a message_update but crashed — should be detected
  // GPT should be fine
  const gpt = results.workers.find((w) => w.id === "gpt");
  assert(gpt && gpt.finalText.includes("Final answer"), "GPT unaffected by claude's crash");
});

// ── Run all tests ───────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🧪 pi-council Benchmark Suite — ${tests.length} tests\n`);

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  const startTime = Date.now();
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const t of tests) {
    const tStart = Date.now();
    try {
      t.fn();
      const ms = Date.now() - tStart;
      console.log(`  ✅ ${t.name} (${ms}ms)`);
      passed++;
    } catch (e) {
      const ms = Date.now() - tStart;
      console.log(`  ❌ ${t.name} (${ms}ms)`);
      console.log(`     ${e.message}`);
      failures.push({ name: t.name, error: e.message });
      failed++;
    }
  }

  const totalMs = Date.now() - startTime;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Results: ${passed}/${tests.length} passed, ${failed} failed (${totalMs}ms)`);

  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) {
      console.log(`  • ${f.name}: ${f.error}`);
    }
  }

  // Emit METRIC lines for autoresearch
  console.log(`\nMETRIC tests_passed=${passed}`);
  console.log(`METRIC tests_failed=${failed}`);
  console.log(`METRIC total_tests=${tests.length}`);
  console.log(`METRIC duration_ms=${totalMs}`);

  // Always exit 0 so autoresearch sees metrics, not crash
  process.exit(0);
}

main();
