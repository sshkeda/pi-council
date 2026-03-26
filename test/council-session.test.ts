import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CouncilSession } from "../src/core/council-session.js";
import type { Config, ModelSpec } from "../src/core/config.js";

const MOCK_PI = path.resolve("test/fixtures/mock-pi.sh");

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-session-"));
}

const fakeModel: ModelSpec = { id: "test", provider: "mock", model: "mock-1" };
const fakeConfig: Config = {
  models: [fakeModel],
  tools: "bash",
  stall_seconds: 60,
  timeout_seconds: 5,
  system_prompt: "test",
};

describe("CouncilSession", () => {
  let tmpDir: string;
  let origPath: string;

  before(() => {
    tmpDir = makeTmpDir();
    // Create a mock pi wrapper
    const wrapperPath = path.join(tmpDir, "pi");
    fs.writeFileSync(wrapperPath, `#!/bin/bash\nexec ${MOCK_PI} "$@"\n`, { mode: 0o755 });
    origPath = process.env.PATH!;
    process.env.PATH = `${tmpDir}:${origPath}`;
  });

  after(() => {
    process.env.PATH = origPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("spawns agents and tracks completion", async () => {
    const runDir = path.join(tmpDir, "run-complete");
    fs.mkdirSync(runDir, { recursive: true });

    let allDoneCalled = false;
    const session = new CouncilSession({
      runId: "test-run", runDir, prompt: "test", models: [fakeModel], config: fakeConfig, cwd: tmpDir,
      events: {
        onAllDone() { allDoneCalled = true; },
      },
    });

    const started = session.start();
    assert.ok(started);
    await session.waitForCompletion();

    assert.ok(session.isDone);
    assert.ok(allDoneCalled);
    assert.equal(session.agents[0].exitCode, 0);
    assert.ok(session.agents[0].output.includes("Mock response"));

    // Artifacts should be written
    assert.ok(fs.existsSync(path.join(runDir, "results.json")));
    assert.ok(fs.existsSync(path.join(runDir, "results.md")));

    session.dispose();
  });

  it("cancels running agents", async () => {
    const runDir = path.join(tmpDir, "run-cancel");
    fs.mkdirSync(runDir, { recursive: true });

    // Use a slow mock
    const slowPi = path.join(tmpDir, "pi-slow");
    fs.writeFileSync(slowPi, '#!/bin/bash\nsleep 30\n', { mode: 0o755 });
    const slowWrapper = path.join(tmpDir, "pi");
    fs.writeFileSync(slowWrapper, `#!/bin/bash\nexec ${slowPi} "$@"\n`, { mode: 0o755 });

    let cancelledCalled = false;
    const session = new CouncilSession({
      runId: "test-cancel", runDir, prompt: "test", models: [fakeModel], config: { ...fakeConfig, timeout_seconds: 0 }, cwd: tmpDir,
      events: {
        onCancelled() { cancelledCalled = true; },
      },
    });

    session.start();

    // Cancel immediately
    session.cancel();
    assert.ok(session.isCancelled);
    assert.ok(cancelledCalled);

    // Restore fast mock
    fs.writeFileSync(path.join(tmpDir, "pi"), `#!/bin/bash\nexec ${MOCK_PI} "$@"\n`, { mode: 0o755 });
    session.dispose();
  });

  it("times out and kills agents", async () => {
    const runDir = path.join(tmpDir, "run-timeout");
    fs.mkdirSync(runDir, { recursive: true });

    // Use a slow mock
    const slowPi = path.join(tmpDir, "pi-slow2");
    fs.writeFileSync(slowPi, '#!/bin/bash\nsleep 30\n', { mode: 0o755 });
    fs.writeFileSync(path.join(tmpDir, "pi"), `#!/bin/bash\nexec ${slowPi} "$@"\n`, { mode: 0o755 });

    let timedOut = false;
    const session = new CouncilSession({
      runId: "test-timeout", runDir, prompt: "test", models: [fakeModel],
      config: { ...fakeConfig, timeout_seconds: 1 }, // 1 second timeout
      cwd: tmpDir,
      events: {
        onTimeout() { timedOut = true; },
      },
    });

    session.start();
    await session.waitForCompletion();

    assert.ok(timedOut);
    assert.ok(session.isCancelled);
    assert.equal(session.agents[0].exitCode, 124);

    // Restore fast mock
    fs.writeFileSync(path.join(tmpDir, "pi"), `#!/bin/bash\nexec ${MOCK_PI} "$@"\n`, { mode: 0o755 });
    session.dispose();
  });

  it("buildSummary produces markdown", () => {
    const runDir = path.join(tmpDir, "run-summary");
    fs.mkdirSync(runDir, { recursive: true });

    const session = new CouncilSession({
      runId: "test-summary", runDir, prompt: "test", models: [fakeModel], config: fakeConfig, cwd: tmpDir,
    });

    // Manually set agent state
    session.agents[0].output = "Hello world";
    session.agents[0].exitCode = 0;

    const md = session.buildSummary();
    assert.ok(md.includes("✅"));
    assert.ok(md.includes("TEST"));
    assert.ok(md.includes("Hello world"));
    session.dispose();
  });

  it("saveArtifacts writes results files", () => {
    const runDir = path.join(tmpDir, "run-artifacts");
    fs.mkdirSync(runDir, { recursive: true });

    const session = new CouncilSession({
      runId: "test-artifacts", runDir, prompt: "artifact test", models: [fakeModel], config: fakeConfig, cwd: tmpDir,
    });

    session.agents[0].output = "Test output";
    session.agents[0].exitCode = 0;
    session.saveArtifacts();

    const json = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf-8"));
    assert.equal(json.runId, "test-artifacts");
    assert.equal(json.workers[0].finalText, "Test output");
    assert.equal(json.workers[0].status, "done");

    const md = fs.readFileSync(path.join(runDir, "results.md"), "utf-8");
    assert.ok(md.includes("Test output"));

    session.dispose();
  });
});
