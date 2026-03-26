import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { spawnWorker, agentPaths } from "../src/core/runner.js";
import { parseStream } from "../src/core/stream-parser.js";
import { createRun } from "../src/core/run-lifecycle.js";
import { loadConfig, type Config, type ModelSpec } from "../src/core/config.js";

const MOCK_PI = path.resolve("test/fixtures/mock-pi.sh");
const MOCK_MODEL: ModelSpec = { id: "test", provider: "mock", model: "mock-1" };

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-integ-"));
}

describe("integration: spawnWorker with mock pi", () => {
  let tmpDir: string;
  let config: Config;

  before(() => {
    tmpDir = makeTmpDir();
    config = {
      ...loadConfig(),
      // Override tools/prompt to be minimal
      tools: "bash",
      system_prompt: "test",
    };
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("spawns a worker and produces JSONL output", async () => {
    // Create a wrapper that calls our mock instead of real pi
    const wrapperPath = path.join(tmpDir, "pi");
    fs.writeFileSync(wrapperPath, `#!/bin/bash\nexec ${MOCK_PI} "$@"\n`, { mode: 0o755 });

    // Temporarily prepend tmpDir to PATH so spawnWorker finds our mock
    const origPath = process.env.PATH;
    process.env.PATH = `${tmpDir}:${origPath}`;

    try {
      const runDir = path.join(tmpDir, "run1");
      fs.mkdirSync(runDir, { recursive: true });

      const { pid, child } = spawnWorker(runDir, MOCK_MODEL, "test prompt", config, tmpDir, false);

      assert.ok(pid > 0, "PID should be positive");

      // Wait for child to finish
      await new Promise<void>((resolve) => {
        child.on("close", () => resolve());
      });

      // Verify .jsonl was written
      const paths = agentPaths(runDir, "test");
      assert.ok(fs.existsSync(paths.stream), "JSONL stream file should exist");

      // Parse the output
      const parsed = parseStream(paths.stream);
      assert.equal(parsed.finalText, "Mock response from test agent");
      assert.equal(parsed.stopReason, "stop");
      assert.equal(parsed.usage.input, 10);
      assert.equal(parsed.usage.output, 5);
      assert.ok(parsed.usage.cost > 0);
    } finally {
      process.env.PATH = origPath;
    }
  });
});

describe("integration: createRun", () => {
  it("creates run directory with meta.json and prompt.txt", () => {
    const { runId, runDir, meta } = createRun("test question", [MOCK_MODEL], "/tmp");

    assert.ok(runId.length > 10, "Run ID should be generated");
    assert.ok(fs.existsSync(runDir), "Run directory should exist");
    assert.ok(fs.existsSync(path.join(runDir, "meta.json")));
    assert.ok(fs.existsSync(path.join(runDir, "prompt.txt")));

    const prompt = fs.readFileSync(path.join(runDir, "prompt.txt"), "utf-8");
    assert.equal(prompt, "test question");
    assert.equal(meta.prompt, "test question");
    assert.equal(meta.agents.length, 1);

    // Cleanup
    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
