/**
 * End-to-end tests: run the actual CLI binary with mock pi and verify full flow.
 * Tests: args → spawn → parse JSONL → write artifacts → exit code.
 */

import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawnSync } from "node:child_process";

const MOCK_PI = path.resolve("test/fixtures/mock-pi.sh");
const CLI = path.resolve("src/cli.ts");

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-e2e-"));
}

function runCli(args: string, env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const fullEnv = { ...process.env, ...env };
  const result = spawnSync("sh", ["-c", `node --import tsx ${CLI} ${args}`], {
    encoding: "utf-8", env: fullEnv, timeout: 30000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 0 };
}

describe("E2E: full CLI flow", () => {
  let tmpDir: string;
  let origPath: string;
  let councilHome: string;

  before(() => {
    tmpDir = makeTmpDir();
    councilHome = path.join(tmpDir, ".pi-council");

    // Create mock pi wrapper
    const wrapper = path.join(tmpDir, "pi");
    fs.writeFileSync(wrapper, `#!/bin/bash\nexport MOCK_BEHAVIOR=\${MOCK_BEHAVIOR:-success}\nexec ${MOCK_PI} "$@"\n`, {
      mode: 0o755,
    });

    origPath = process.env.PATH!;
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function cli(args: string, behavior = "success"): { stdout: string; stderr: string; exitCode: number } {
    return runCli(args, {
      PATH: `${tmpDir}:${origPath}`,
      PI_COUNCIL_HOME: councilHome,
      MOCK_BEHAVIOR: behavior,
    });
  }

  it("ask: spawns agents, gets results, writes artifacts", () => {
    const r = cli('ask --models claude "What is 2+2?"');
    assert.equal(r.exitCode, 0, `Expected exit 0, got ${r.exitCode}. stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("Mock answer"), `stdout should contain mock answer. Got: ${r.stdout}`);

    // Verify artifacts were written
    const runsDir = path.join(councilHome, "runs");
    const runs = fs.readdirSync(runsDir);
    assert.ok(runs.length > 0, "Should have at least one run");

    const latestRun = runs.sort().reverse()[0];
    const runDir = path.join(runsDir, latestRun);
    assert.ok(fs.existsSync(path.join(runDir, "results.json")), "results.json should exist");
    assert.ok(fs.existsSync(path.join(runDir, "results.md")), "results.md should exist");
    assert.ok(fs.existsSync(path.join(runDir, "meta.json")), "meta.json should exist");

    const results = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf-8"));
    assert.equal(results.workers.length, 1);
    assert.equal(results.workers[0].status, "done");
    assert.ok(results.workers[0].finalText.includes("Mock answer"));
  });

  it("ask: handles error stopReason correctly", () => {
    const r = cli('ask --models claude "test"', "error");
    assert.notEqual(r.exitCode, 0, "Should exit non-zero on error");
  });

  it("status: shows run status", () => {
    const r = cli("status");
    // Should find the run from the previous test
    assert.ok(
      r.stderr.includes("complete") || r.stderr.includes("done") || r.stderr.includes("failed"),
      `Expected status output. stderr: ${r.stderr}`,
    );
  });

  it("list: shows all runs", () => {
    const r = cli("list");
    assert.ok(r.stderr.includes("RUN-ID"), `Expected header. stderr: ${r.stderr}`);
  });

  it("help: prints usage", () => {
    const r = cli("--help");
    assert.ok(r.stderr.includes("pi-council"), `Expected help text. stderr: ${r.stderr}`);
  });

  it("version: prints version", () => {
    const r = cli("--version");
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/, `Expected semver. Got: ${r.stdout}`);
  });

  it("spawn + results: background mode works", () => {
    const spawn = cli('spawn --models claude "background test"');
    assert.equal(spawn.exitCode, 0, `spawn failed: ${spawn.stderr}`);
    const runId = spawn.stdout.trim();
    assert.ok(runId.length > 10, `Expected run ID, got: ${runId}`);

    // Wait for completion (poll)
    let done = false;
    for (let i = 0; i < 10; i++) {
      const s = cli(`status --run-id ${runId}`);
      if (s.stderr.includes("1/1 complete")) {
        done = true;
        break;
      }
      execSync("sleep 1");
    }
    assert.ok(done, "Background run should complete within 10s");

    // Get results
    const results = cli(`results --run-id ${runId}`);
    assert.ok(results.stdout.includes("Mock answer"), `Expected mock answer in results. stdout: ${results.stdout}`);
  });

  it("cleanup: removes run directory", () => {
    const spawn = cli('spawn --models claude "cleanup test"');
    const runId = spawn.stdout.trim();
    execSync("sleep 2"); // let it finish

    const r = cli(`cleanup --run-id ${runId}`);
    assert.ok(r.stderr.includes("Cleaned up"), `Expected cleanup confirmation. stderr: ${r.stderr}`);

    // Run dir should be gone
    const runDir = path.join(councilHome, "runs", runId);
    assert.ok(!fs.existsSync(runDir), "Run directory should be deleted");
  });

  it("multi-model: spawns multiple agents", () => {
    const r = cli('ask --models claude,grok "multi model test"');
    assert.equal(r.exitCode, 0, `Exit code: ${r.exitCode}. stderr: ${r.stderr}`);
    // Should have 2 model outputs
    assert.ok(r.stdout.includes("CLAUDE"), "Should have Claude output");
    assert.ok(r.stdout.includes("GROK"), "Should have Grok output");
  });
});
