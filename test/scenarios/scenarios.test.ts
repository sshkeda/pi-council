/**
 * End-to-end scenario tests for pi-council using mock pi binary.
 * Tests real functionality: spawn → track → parse → artifacts.
 * No API calls needed — fully deterministic.
 */

import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { spawnWorker, agentPaths } from "../../src/core/runner.js";
import { parseStream } from "../../src/core/stream-parser.js";
import { createRun } from "../../src/core/run-lifecycle.js";
import { loadConfig, type Config, type ModelSpec } from "../../src/core/config.js";
import { refreshWorker, isAgentDone } from "../../src/core/run-state.js";
import { CouncilSession, type AgentState } from "../../src/core/council-session.js";
import { writeArtifacts, type WorkerResult } from "../../src/core/artifacts.js";

const MOCK_PI = path.resolve("test/scenarios/mock-pi.sh");
const fakeModel = (id: string): ModelSpec => ({ id, provider: "mock", model: "mock-1" });

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-scenario-"));
}

function setupMockPi(tmpDir: string, behavior: string): { origPath: string; config: Config } {
  // Create a wrapper that sets MOCK_BEHAVIOR and calls mock-pi.sh
  const wrapper = path.join(tmpDir, "pi");
  fs.writeFileSync(wrapper, `#!/bin/bash\nexport MOCK_BEHAVIOR="${behavior}"\nexport MOCK_MODEL="\${*: -1}"\nexec ${MOCK_PI} "$@"\n`, { mode: 0o755 });
  
  const origPath = process.env.PATH!;
  process.env.PATH = `${tmpDir}:${origPath}`;
  process.env.PI_COUNCIL_HOME = path.join(tmpDir, ".pi-council");
  
  const config: Config = {
    models: [fakeModel("test")],
    tools: "bash",
    stall_seconds: 2,
    timeout_seconds: 5,
    system_prompt: "test",
  };
  
  return { origPath, config };
}

function teardown(origPath: string): void {
  process.env.PATH = origPath;
  delete process.env.PI_COUNCIL_HOME;
}

// ============================================================
// Scenario 1: Basic Success
// ============================================================
describe("Scenario: basic success", () => {
  let tmpDir: string, origPath: string, config: Config;

  before(() => {
    tmpDir = makeTmpDir();
    ({ origPath, config } = setupMockPi(tmpDir, "success"));
  });
  after(() => { teardown(origPath); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("spawns agent, gets final text, writes artifacts", async () => {
    const runDir = path.join(tmpDir, "run-success");
    fs.mkdirSync(runDir, { recursive: true });

    const session = new CouncilSession({
      runId: "test-success", runDir, prompt: "test", 
      models: [fakeModel("agent1")], config, cwd: tmpDir,
    });

    assert.ok(session.start());
    await session.waitForCompletion();

    assert.ok(session.isDone);
    assert.equal(session.agents[0].exitCode, 0);
    assert.ok(session.agents[0].output.includes("Mock answer"));
    assert.ok(fs.existsSync(path.join(runDir, "results.json")));

    const results = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf-8"));
    assert.equal(results.workers[0].status, "done");
    assert.ok(results.workers[0].usage.cost > 0);
    session.dispose();
  });
});

// ============================================================
// Scenario 2: Error handling
// ============================================================
describe("Scenario: error handling", () => {
  let tmpDir: string, origPath: string, config: Config;

  before(() => {
    tmpDir = makeTmpDir();
    ({ origPath, config } = setupMockPi(tmpDir, "error"));
  });
  after(() => { teardown(origPath); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("detects error stopReason and reports failure", async () => {
    const runDir = path.join(tmpDir, "run-error");
    fs.mkdirSync(runDir, { recursive: true });

    const session = new CouncilSession({
      runId: "test-error", runDir, prompt: "test",
      models: [fakeModel("agent1")], config, cwd: tmpDir,
    });

    session.start();
    await session.waitForCompletion();

    // The mock exits 0 but with stopReason=error
    const parsed = parseStream(agentPaths(runDir, "agent1").stream);
    assert.equal(parsed.stopReason, "error");
    assert.equal(parsed.errorMessage, "Mock API error");
    session.dispose();
  });
});

// ============================================================
// Scenario 3: Large output (1000+ events)
// ============================================================
describe("Scenario: large output", () => {
  let tmpDir: string, origPath: string, config: Config;

  before(() => {
    tmpDir = makeTmpDir();
    ({ origPath, config } = setupMockPi(tmpDir, "large"));
  });
  after(() => { teardown(origPath); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("parses 1000+ events without crash or data loss", async () => {
    const runDir = path.join(tmpDir, "run-large");
    fs.mkdirSync(runDir, { recursive: true });

    const session = new CouncilSession({
      runId: "test-large", runDir, prompt: "test",
      models: [fakeModel("agent1")], config, cwd: tmpDir,
    });

    session.start();
    await session.waitForCompletion();

    const parsed = parseStream(agentPaths(runDir, "agent1").stream);
    assert.ok(parsed.events > 1000, `Expected >1000 events, got ${parsed.events}`);
    assert.equal(parsed.finalText, "Final answer after 1000 events");
    assert.equal(parsed.toolCalls, 1);
    assert.ok(parsed.usage.cost > 0);
    session.dispose();
  });
});

// ============================================================
// Scenario 4: Malformed JSONL
// ============================================================
describe("Scenario: malformed JSONL", () => {
  let tmpDir: string, origPath: string, config: Config;

  before(() => {
    tmpDir = makeTmpDir();
    ({ origPath, config } = setupMockPi(tmpDir, "malformed"));
  });
  after(() => { teardown(origPath); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("skips bad lines, extracts valid data", async () => {
    const runDir = path.join(tmpDir, "run-malformed");
    fs.mkdirSync(runDir, { recursive: true });

    const session = new CouncilSession({
      runId: "test-malformed", runDir, prompt: "test",
      models: [fakeModel("agent1")], config, cwd: tmpDir,
    });

    session.start();
    await session.waitForCompletion();

    const parsed = parseStream(agentPaths(runDir, "agent1").stream);
    // Should have parsed valid lines, skipped bad ones
    assert.ok(parsed.events >= 2, `Expected >=2 valid events, got ${parsed.events}`);
    assert.equal(parsed.finalText, "After bad lines");
    session.dispose();
  });
});

// ============================================================
// Scenario 5: Crash with partial output
// ============================================================
describe("Scenario: crash with partial output", () => {
  let tmpDir: string, origPath: string, config: Config;

  before(() => {
    tmpDir = makeTmpDir();
    ({ origPath, config } = setupMockPi(tmpDir, "crash"));
  });
  after(() => { teardown(origPath); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("detects crash, preserves partial text", async () => {
    const runDir = path.join(tmpDir, "run-crash");
    fs.mkdirSync(runDir, { recursive: true });

    const session = new CouncilSession({
      runId: "test-crash", runDir, prompt: "test",
      models: [fakeModel("agent1")], config, cwd: tmpDir,
    });

    session.start();
    await session.waitForCompletion();

    // Agent crashed with exit 1
    assert.notEqual(session.agents[0].exitCode, 0);
    // Partial text should be preserved as assistantText
    const parsed = parseStream(agentPaths(runDir, "agent1").stream);
    assert.ok(parsed.assistantText.includes("Started working"));
    session.dispose();
  });
});

// ============================================================
// Scenario 6: Timeout enforcement
// ============================================================
describe("Scenario: timeout", () => {
  let tmpDir: string, origPath: string, config: Config;

  before(() => {
    tmpDir = makeTmpDir();
    ({ origPath, config } = setupMockPi(tmpDir, "hang"));
    config.timeout_seconds = 2; // Short timeout for testing
  });
  after(() => { teardown(origPath); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("kills agent after timeout, reports correctly", async () => {
    const runDir = path.join(tmpDir, "run-timeout");
    fs.mkdirSync(runDir, { recursive: true });

    let timedOut = false;
    const session = new CouncilSession({
      runId: "test-timeout", runDir, prompt: "test",
      models: [fakeModel("agent1")], config, cwd: tmpDir,
      timeoutSeconds: 2,
      events: { onTimeout() { timedOut = true; } },
    });

    session.start();
    await session.waitForCompletion();

    assert.ok(timedOut);
    assert.ok(session.isTimedOut);
    assert.equal(session.agents[0].exitCode, 124);
    session.dispose();
  });
});

// ============================================================
// Scenario 7: Cancellation
// ============================================================
describe("Scenario: cancellation", () => {
  let tmpDir: string, origPath: string, config: Config;

  before(() => {
    tmpDir = makeTmpDir();
    ({ origPath, config } = setupMockPi(tmpDir, "hang"));
  });
  after(() => { teardown(origPath); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("kills agents on cancel, saves partial artifacts", () => {
    const runDir = path.join(tmpDir, "run-cancel");
    fs.mkdirSync(runDir, { recursive: true });

    let cancelledCalled = false;
    const session = new CouncilSession({
      runId: "test-cancel", runDir, prompt: "test",
      models: [fakeModel("agent1")], config, cwd: tmpDir,
      timeoutSeconds: 0, // no timeout
      events: { onCancelled() { cancelledCalled = true; } },
    });

    session.start();
    session.cancel();

    assert.ok(session.isCancelled);
    assert.ok(cancelledCalled);
    assert.ok(fs.existsSync(path.join(runDir, "results.json")));
    session.dispose();
  });
});

// ============================================================
// Scenario 8: Empty output
// ============================================================
describe("Scenario: empty output", () => {
  let tmpDir: string, origPath: string, config: Config;

  before(() => {
    tmpDir = makeTmpDir();
    ({ origPath, config } = setupMockPi(tmpDir, "empty"));
  });
  after(() => { teardown(origPath); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("handles empty stream gracefully", async () => {
    const runDir = path.join(tmpDir, "run-empty");
    fs.mkdirSync(runDir, { recursive: true });

    const session = new CouncilSession({
      runId: "test-empty", runDir, prompt: "test",
      models: [fakeModel("agent1")], config, cwd: tmpDir,
    });

    session.start();
    await session.waitForCompletion();

    const parsed = parseStream(agentPaths(runDir, "agent1").stream);
    assert.equal(parsed.events, 0);
    assert.equal(parsed.finalText, "");
    session.dispose();
  });
});

// ============================================================
// Scenario 9: refreshWorker state machine truth table
// ============================================================
describe("Scenario: refreshWorker state machine", () => {
  it("pid alive + no done = running", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "test.pid"), String(process.pid)); // own PID = alive
    fs.writeFileSync(path.join(dir, "test.jsonl"), "");
    fs.writeFileSync(path.join(dir, "test.err"), "");
    const w = refreshWorker(dir, fakeModel("test"), 60);
    assert.equal(w.status, "running");
    fs.rmSync(dir, { recursive: true });
  });

  it("pid dead + no done + has text = done (with .done created)", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "test.pid"), "999999999"); // dead PID
    fs.writeFileSync(path.join(dir, "test.jsonl"), '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"answer"}],"stopReason":"stop"}}\n');
    fs.writeFileSync(path.join(dir, "test.err"), "");
    const w = refreshWorker(dir, fakeModel("test"), 60);
    assert.equal(w.status, "done");
    assert.ok(fs.existsSync(path.join(dir, "test.done")));
    fs.rmSync(dir, { recursive: true });
  });

  it("done=0 = success", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "test.done"), "0");
    fs.writeFileSync(path.join(dir, "test.pid"), "999999999");
    fs.writeFileSync(path.join(dir, "test.jsonl"), "");
    const w = refreshWorker(dir, fakeModel("test"), 60);
    assert.equal(w.status, "done");
    fs.rmSync(dir, { recursive: true });
  });

  it("done=1 = failed", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "test.done"), "1");
    fs.writeFileSync(path.join(dir, "test.pid"), "999999999");
    fs.writeFileSync(path.join(dir, "test.jsonl"), "");
    fs.writeFileSync(path.join(dir, "test.err"), "some error");
    const w = refreshWorker(dir, fakeModel("test"), 60);
    assert.equal(w.status, "failed");
    assert.ok(w.errorMessage?.includes("some error"));
    fs.rmSync(dir, { recursive: true });
  });

  it("done=cancelled = failed", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "test.done"), "cancelled");
    fs.writeFileSync(path.join(dir, "test.pid"), "999999999");
    fs.writeFileSync(path.join(dir, "test.jsonl"), '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial"}],"stopReason":"stop"}}\n');
    const w = refreshWorker(dir, fakeModel("test"), 60);
    assert.equal(w.status, "failed");
    fs.rmSync(dir, { recursive: true });
  });

  it("done=124 (timeout) = failed", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "test.done"), "124");
    fs.writeFileSync(path.join(dir, "test.pid"), "999999999");
    fs.writeFileSync(path.join(dir, "test.jsonl"), "");
    const w = refreshWorker(dir, fakeModel("test"), 60);
    assert.equal(w.status, "failed");
    fs.rmSync(dir, { recursive: true });
  });
});

// ============================================================
// Scenario 10: Multi-model with mixed outcomes
// ============================================================
describe("Scenario: multi-model mixed outcomes", () => {
  let tmpDir: string, origPath: string, config: Config;

  before(() => {
    tmpDir = makeTmpDir();
    // Create per-model wrappers with different behaviors
    const wrapper = path.join(tmpDir, "pi");
    // Route behavior based on --model flag value
    fs.writeFileSync(wrapper, `#!/bin/bash
MODEL=""
while [ $# -gt 0 ]; do
  case "$1" in --model) MODEL="$2"; shift 2;; *) shift;; esac
done
case "$MODEL" in
  success-model) export MOCK_BEHAVIOR=success ;;
  error-model) export MOCK_BEHAVIOR=error ;;
  *) export MOCK_BEHAVIOR=success ;;
esac
exec ${MOCK_PI} "$@"
`, { mode: 0o755 });

    const origP = process.env.PATH!;
    process.env.PATH = `${tmpDir}:${origP}`;
    process.env.PI_COUNCIL_HOME = path.join(tmpDir, ".pi-council");

    config = {
      models: [
        { id: "good", provider: "mock", model: "success-model" },
        { id: "bad", provider: "mock", model: "error-model" },
      ],
      tools: "bash", stall_seconds: 60, timeout_seconds: 10, system_prompt: "test",
    };

    origPath = origP;
  });
  after(() => { teardown(origPath); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("handles mixed success/failure correctly", async () => {
    const runDir = path.join(tmpDir, "run-mixed");
    fs.mkdirSync(runDir, { recursive: true });

    const session = new CouncilSession({
      runId: "test-mixed", runDir, prompt: "test mixed",
      models: config.models, config, cwd: tmpDir,
    });

    session.start();
    await session.waitForCompletion();

    // Check results
    const good = session.agents.find(a => a.id === "good")!;
    const bad = session.agents.find(a => a.id === "bad")!;

    assert.equal(good.exitCode, 0);
    assert.ok(good.output.includes("Mock answer"));

    // bad model emitted error stopReason
    const badParsed = parseStream(agentPaths(runDir, "bad").stream);
    assert.equal(badParsed.stopReason, "error");

    // Artifacts should exist
    const results = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf-8"));
    assert.equal(results.workers.length, 2);

    session.dispose();
  });
});

// ============================================================
// Scenario 11: Parser fidelity — adversarial JSONL
// ============================================================
describe("Scenario: parser adversarial JSONL", () => {
  it("rejects non-pi valid JSON (no type field)", () => {
    const dir = makeTmpDir();
    const f = path.join(dir, "test.jsonl");
    fs.writeFileSync(f, '{"random": true}\n{"array": [1,2,3]}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"valid"}],"stopReason":"stop"}}\n');
    const r = parseStream(f);
    assert.equal(r.events, 1, "Should only count the valid pi event");
    assert.equal(r.finalText, "valid");
    fs.rmSync(dir, { recursive: true });
  });

  it("handles CRLF line endings", () => {
    const dir = makeTmpDir();
    const f = path.join(dir, "test.jsonl");
    fs.writeFileSync(f, '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"crlf test"}],"stopReason":"stop"}}\r\n');
    const r = parseStream(f);
    assert.equal(r.finalText, "crlf test");
    fs.rmSync(dir, { recursive: true });
  });

  it("handles empty lines between events", () => {
    const dir = makeTmpDir();
    const f = path.join(dir, "test.jsonl");
    fs.writeFileSync(f, '\n\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"spaced"}],"stopReason":"stop"}}\n\n\n');
    const r = parseStream(f);
    assert.equal(r.events, 1);
    assert.equal(r.finalText, "spaced");
    fs.rmSync(dir, { recursive: true });
  });

  it("handles unicode/emoji in text", () => {
    const dir = makeTmpDir();
    const f = path.join(dir, "test.jsonl");
    const text = "Hello 🌍 café über naïve 中文";
    fs.writeFileSync(f, JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text}],stopReason:"stop"}}) + "\n");
    const r = parseStream(f);
    assert.equal(r.finalText, text);
    fs.rmSync(dir, { recursive: true });
  });
});

// ============================================================
// Scenario 12: Stall detection
// ============================================================
describe("Scenario: stall detection", () => {
  it("detects stalled agent based on mtime", () => {
    const dir = makeTmpDir();
    // Create files with old mtime
    fs.writeFileSync(path.join(dir, "test.pid"), String(process.pid)); // alive
    fs.writeFileSync(path.join(dir, "test.jsonl"), "");
    fs.writeFileSync(path.join(dir, "test.err"), "");
    
    // Set mtime to 120 seconds ago
    const oldTime = new Date(Date.now() - 120_000);
    fs.utimesSync(path.join(dir, "test.jsonl"), oldTime, oldTime);
    fs.utimesSync(path.join(dir, "test.err"), oldTime, oldTime);
    
    const w = refreshWorker(dir, fakeModel("test"), 5); // 5s stall threshold
    assert.equal(w.status, "stalled");
    fs.rmSync(dir, { recursive: true });
  });

  it("running (not stalled) when files are fresh", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "test.pid"), String(process.pid));
    fs.writeFileSync(path.join(dir, "test.jsonl"), "");
    fs.writeFileSync(path.join(dir, "test.err"), "");
    // Files just created = fresh mtime
    const w = refreshWorker(dir, fakeModel("test"), 60);
    assert.equal(w.status, "running");
    fs.rmSync(dir, { recursive: true });
  });
});

// ============================================================
// Scenario 13: Comprehensive state machine truth table
// ============================================================
describe("Scenario: state machine comprehensive", () => {
  // pid_exists × pid_alive × done_exists × done_content × stream_has_final
  
  it("no pid, no done, no stream = failed (unknown state)", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "test.jsonl"), "");
    const w = refreshWorker(dir, fakeModel("test"), 60);
    assert.equal(w.status, "failed");
    fs.rmSync(dir, { recursive: true });
  });

  it("pid alive, done=0, stream with final = done (race: done written early)", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "test.pid"), String(process.pid));
    fs.writeFileSync(path.join(dir, "test.done"), "0");
    fs.writeFileSync(path.join(dir, "test.jsonl"), '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"answer"}],"stopReason":"stop"}}\n');
    const w = refreshWorker(dir, fakeModel("test"), 60);
    assert.equal(w.status, "done");
    fs.rmSync(dir, { recursive: true });
  });

  it("pid dead, done empty, stream has stopReason=stop = done", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "test.pid"), "999999999");
    fs.writeFileSync(path.join(dir, "test.jsonl"), '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}\n');
    const w = refreshWorker(dir, fakeModel("test"), 60);
    assert.equal(w.status, "done");
    fs.rmSync(dir, { recursive: true });
  });

  it("pid dead, done empty, stream has no stopReason=stop = failed", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "test.pid"), "999999999");
    fs.writeFileSync(path.join(dir, "test.jsonl"), '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]}}\n');
    const w = refreshWorker(dir, fakeModel("test"), 60);
    assert.equal(w.status, "failed");
    fs.rmSync(dir, { recursive: true });
  });

  it("pid dead, no done file = creates done marker and resolves", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "test.pid"), "999999999");
    fs.writeFileSync(path.join(dir, "test.jsonl"), "");
    assert.ok(!fs.existsSync(path.join(dir, "test.done")));
    const w = refreshWorker(dir, fakeModel("test"), 60);
    assert.ok(fs.existsSync(path.join(dir, "test.done")), ".done should be created");
    assert.equal(w.status, "failed"); // no final text
    fs.rmSync(dir, { recursive: true });
  });
});
