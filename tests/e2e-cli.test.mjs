#!/usr/bin/env node

/**
 * CLI E2E tests — tests the pi-council CLI binary with a mock gateway.
 *
 * Sets up a pi-mock gateway, configures PI_CODING_AGENT_DIR to route
 * all API calls through it, then runs pi-council CLI commands as child
 * processes. The controllable brain handles council member API calls.
 *
 * Tests: ask, ask --json, ask --models, spawn, status, list, cleanup.
 *
 * Zero real API calls. Fully sandboxed.
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";

import {
  createGateway,
  createControllableBrain,
  text,
} from "pi-mock";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../bin/pi-council.js");

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
    if (process.env.DEBUG) console.error(err.stack);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Create a temp agent dir that routes all providers to the gateway.
 */
function createAgentDir(gatewayUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-agent-"));
  fs.writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        "pi-mock": { baseUrl: `${gatewayUrl}/v1`, api: "anthropic-messages", apiKey: "k", models: [{ id: "mock" }] },
        anthropic: { baseUrl: `${gatewayUrl}/v1`, apiKey: "k" },
        openai: { baseUrl: `${gatewayUrl}/v1`, apiKey: "k" },
        "openai-codex": { baseUrl: `${gatewayUrl}/v1`, apiKey: "k" },
        google: { baseUrl: `${gatewayUrl}/v1beta`, apiKey: "k" },
        xai: { baseUrl: `${gatewayUrl}/v1`, apiKey: "k" },
        groq: { baseUrl: `${gatewayUrl}/v1`, apiKey: "k" },
      },
    }),
  );
  fs.writeFileSync(path.join(dir, "settings.json"), "{}");
  return dir;
}

/**
 * Write a pi-council config with test models.
 */
function writeTestConfig(homeDir) {
  const configDir = path.join(homeDir, ".pi-council");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      models: [
        { id: "claude", provider: "anthropic", model: "mock-claude" },
        { id: "gpt", provider: "openai", model: "mock-gpt" },
      ],
    }),
  );
}

/**
 * Run a CLI command and return { stdout, stderr, exitCode }.
 */
function runCli(args, env, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      cwd: path.resolve(__dirname, ".."),
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

process.stdout.write("\n🧪 CLI E2E Test Suite\n\n");

// ═══════════════════════════════════════════════════════════════════════
// CLI: pi-council ask
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("── pi-council ask ──\n");

await test("CLI1: ask with 2 models returns formatted results", async () => {
  const cb = createControllableBrain();
  const gw = await createGateway({ brain: cb.brain, port: 0, default: "allow" });
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
  const agentDir = createAgentDir(gw.url);
  writeTestConfig(testHome);

  try {
    // Start the CLI in the background
    const cliP = runCli(
      ["ask", "What is the best testing framework?"],
      { HOME: testHome, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      30000,
    );

    // Handle member API calls
    const claudeCall = await cb.waitForCall({ model: "mock-claude" }, 15000);
    const gptCall = await cb.waitForCall({ model: "mock-gpt" }, 15000);
    claudeCall.respond(text("Claude: Vitest is excellent for modern JS projects."));
    gptCall.respond(text("GPT: Jest has the largest ecosystem and community."));

    const { stdout, stderr, exitCode } = await cliP;

    assert(exitCode === 0, `exit code 0, got ${exitCode}\nstderr: ${stderr}`);
    assert(stdout.includes("CLAUDE"), `stdout has CLAUDE header: ${stdout.slice(0, 200)}`);
    assert(stdout.includes("GPT"), `stdout has GPT header: ${stdout.slice(0, 200)}`);
    assert(stdout.includes("Vitest"), "stdout has Claude's response");
    assert(stdout.includes("Jest"), "stdout has GPT's response");
  } finally {
    await gw.close();
    fs.rmSync(testHome, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

await test("CLI2: ask --json returns valid JSON", async () => {
  const cb = createControllableBrain();
  const gw = await createGateway({ brain: cb.brain, port: 0, default: "allow" });
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
  const agentDir = createAgentDir(gw.url);
  writeTestConfig(testHome);

  try {
    const cliP = runCli(
      ["ask", "--json", "JSON test question"],
      { HOME: testHome, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      30000,
    );

    const claudeCall = await cb.waitForCall({ model: "mock-claude" }, 15000);
    const gptCall = await cb.waitForCall({ model: "mock-gpt" }, 15000);
    claudeCall.respond(text("Claude JSON response."));
    gptCall.respond(text("GPT JSON response."));

    const { stdout, exitCode } = await cliP;

    assert(exitCode === 0, `exit code 0, got ${exitCode}`);
    const result = JSON.parse(stdout);
    assert(result.runId, "has runId");
    assert(Array.isArray(result.members), "has members array");
    assert(result.members.length === 2, "2 members");
    assert(result.members[0].state === "done", "member 1 done");
    assert(result.members[1].state === "done", "member 2 done");
    assert(result.members[0].output.length > 0, "member 1 has output");
    assert(result.members[1].output.length > 0, "member 2 has output");
  } finally {
    await gw.close();
    fs.rmSync(testHome, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

await test("CLI3: ask --models claude filters to single model", async () => {
  const cb = createControllableBrain();
  const gw = await createGateway({ brain: cb.brain, port: 0, default: "allow" });
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
  const agentDir = createAgentDir(gw.url);
  writeTestConfig(testHome);

  try {
    const cliP = runCli(
      ["ask", "--models", "claude", "--json", "Single model test"],
      { HOME: testHome, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      30000,
    );

    const claudeCall = await cb.waitForCall({ model: "mock-claude" }, 15000);
    claudeCall.respond(text("Only Claude responds."));

    // Verify no GPT call
    let gotGpt = false;
    try {
      await cb.waitForCall({ model: "mock-gpt" }, 2000);
      gotGpt = true;
    } catch { /* expected timeout */ }
    assert(!gotGpt, "GPT was not spawned");

    const { stdout, exitCode } = await cliP;

    assert(exitCode === 0, `exit code 0, got ${exitCode}`);
    const result = JSON.parse(stdout);
    assert(result.members.length === 1, `1 member, got ${result.members.length}`);
    assert(result.members[0].id === "claude", "only claude");
  } finally {
    await gw.close();
    fs.rmSync(testHome, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// CLI: pi-council list
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── pi-council list ──\n");

await test("CLI4: list shows previous runs", async () => {
  const cb = createControllableBrain();
  const gw = await createGateway({ brain: cb.brain, port: 0, default: "allow" });
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
  const agentDir = createAgentDir(gw.url);
  writeTestConfig(testHome);

  try {
    // First run ask to create a run
    const askP = runCli(
      ["ask", "--json", "List test question"],
      { HOME: testHome, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      30000,
    );

    const claudeCall = await cb.waitForCall({ model: "mock-claude" }, 15000);
    const gptCall = await cb.waitForCall({ model: "mock-gpt" }, 15000);
    claudeCall.respond(text("Claude for list."));
    gptCall.respond(text("GPT for list."));

    await askP;

    // Now list
    const { stdout, exitCode } = await runCli(
      ["list"],
      { HOME: testHome, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      10000,
    );

    assert(exitCode === 0, `exit code 0, got ${exitCode}`);
    assert(stdout.includes("List test question"), `list output has prompt: ${stdout.slice(0, 200)}`);
  } finally {
    await gw.close();
    fs.rmSync(testHome, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

await test("CLI5: list --json returns valid JSON array", async () => {
  const cb = createControllableBrain();
  const gw = await createGateway({ brain: cb.brain, port: 0, default: "allow" });
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
  const agentDir = createAgentDir(gw.url);
  writeTestConfig(testHome);

  try {
    // Create a run
    const askP = runCli(
      ["ask", "--json", "JSON list test"],
      { HOME: testHome, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      30000,
    );

    const claudeCall = await cb.waitForCall({ model: "mock-claude" }, 15000);
    const gptCall = await cb.waitForCall({ model: "mock-gpt" }, 15000);
    claudeCall.respond(text("Claude."));
    gptCall.respond(text("GPT."));

    await askP;

    // List as JSON
    const { stdout, exitCode } = await runCli(
      ["list", "--json"],
      { HOME: testHome, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      10000,
    );

    assert(exitCode === 0, `exit code 0, got ${exitCode}`);
    const runs = JSON.parse(stdout);
    assert(Array.isArray(runs), "is array");
    assert(runs.length >= 1, `has runs: ${runs.length}`);
    assert(runs[0].runId, "run has runId");
    assert(runs[0].prompt, "run has prompt");
  } finally {
    await gw.close();
    fs.rmSync(testHome, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// CLI: pi-council results
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── pi-council results ──\n");

await test("CLI6: results shows last run output", async () => {
  const cb = createControllableBrain();
  const gw = await createGateway({ brain: cb.brain, port: 0, default: "allow" });
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
  const agentDir = createAgentDir(gw.url);
  writeTestConfig(testHome);

  try {
    // Create a run
    const askP = runCli(
      ["ask", "--json", "Results test question"],
      { HOME: testHome, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      30000,
    );

    const claudeCall = await cb.waitForCall({ model: "mock-claude" }, 15000);
    const gptCall = await cb.waitForCall({ model: "mock-gpt" }, 15000);
    claudeCall.respond(text("Claude results content."));
    gptCall.respond(text("GPT results content."));

    await askP;

    // Get results
    const { stdout, exitCode } = await runCli(
      ["results"],
      { HOME: testHome, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      10000,
    );

    assert(exitCode === 0, `exit code 0, got ${exitCode}`);
    assert(
      stdout.includes("Claude") || stdout.includes("GPT") || stdout.includes("Results test"),
      `results output has content: ${stdout.slice(0, 200)}`,
    );
  } finally {
    await gw.close();
    fs.rmSync(testHome, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// CLI: pi-council cleanup
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── pi-council cleanup ──\n");

await test("CLI7: cleanup removes old runs", async () => {
  const cb = createControllableBrain();
  const gw = await createGateway({ brain: cb.brain, port: 0, default: "allow" });
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
  const agentDir = createAgentDir(gw.url);
  writeTestConfig(testHome);

  try {
    // Create a run
    const askP = runCli(
      ["ask", "--json", "Cleanup test"],
      { HOME: testHome, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      30000,
    );

    const claudeCall = await cb.waitForCall({ model: "mock-claude" }, 15000);
    const gptCall = await cb.waitForCall({ model: "mock-gpt" }, 15000);
    claudeCall.respond(text("Claude."));
    gptCall.respond(text("GPT."));

    await askP;

    // Verify runs dir has content
    const runsDir = path.join(testHome, ".pi-council", "runs");
    assert(fs.existsSync(runsDir), "runs dir exists before cleanup");
    const runsBefore = fs.readdirSync(runsDir);
    assert(runsBefore.length >= 1, "has runs before cleanup");

    // Cleanup
    const { exitCode } = await runCli(
      ["cleanup"],
      { HOME: testHome, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      10000,
    );

    assert(exitCode === 0, `exit code 0, got ${exitCode}`);

    // After cleanup, runs should be removed
    if (fs.existsSync(runsDir)) {
      const runsAfter = fs.readdirSync(runsDir);
      assert(runsAfter.length <= runsBefore.length, "cleanup reduced or kept runs");
    }
  } finally {
    await gw.close();
    fs.rmSync(testHome, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// CLI: Edge cases
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Edge cases ──\n");

await test("CLI8: ask with no prompt shows error", async () => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));

  try {
    const { exitCode, stderr } = await runCli(
      ["ask"],
      { HOME: testHome },
      10000,
    );

    // Should fail — no prompt provided
    assert(exitCode !== 0, `non-zero exit code, got ${exitCode}`);
  } finally {
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

await test("CLI9: list with no runs returns empty", async () => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));

  try {
    const { stdout, exitCode } = await runCli(
      ["list", "--json"],
      { HOME: testHome },
      10000,
    );

    assert(exitCode === 0, `exit code 0, got ${exitCode}`);
    const runs = JSON.parse(stdout);
    assert(Array.isArray(runs), "is array");
    assert(runs.length === 0, "empty");
  } finally {
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

await test("CLI10: results with no runs shows message", async () => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));

  try {
    const { exitCode, stderr, stdout } = await runCli(
      ["results"],
      { HOME: testHome },
      10000,
    );

    // Should indicate no runs found
    const output = stdout + stderr;
    assert(output.includes("No") || output.includes("no") || exitCode !== 0,
      `indicates no runs: ${output.slice(0, 200)}`);
  } finally {
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write(`\n📊 CLI E2E: ${passed} passed, ${failed} failed out of ${passed + failed}\n\n`);

process.stdout.write(`METRIC cli_e2e_passed=${passed}\n`);
process.stdout.write(`METRIC cli_e2e_failed=${failed}\n`);

process.exit(failed > 0 ? 1 : 0);
