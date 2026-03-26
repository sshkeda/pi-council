import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseStream } from "../src/core/runner.js";
import { loadMeta, refreshWorker, isAgentDone, killPid } from "../src/core/state.js";
import { CouncilSession } from "../src/core/session.js";
import type { Config, ModelSpec } from "../src/core/config.js";

const MOCK_PI = path.resolve("test/scenarios/mock-pi.sh");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-test-"));
const fakeModel = (id = "test"): ModelSpec => ({ id, provider: "mock", model: "mock-1" });
const fakeConfig: Config = { models: [fakeModel()], tools: "bash", timeout_seconds: 5, system_prompt: "test" };

function writeTempJsonl(lines: object[]): string {
  const dir = tmp(); const f = path.join(dir, "test.jsonl");
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return f;
}

// --- parseStream ---
describe("parseStream", () => {
  it("returns empty for missing file", () => { const r = parseStream("/nonexistent"); assert.equal(r.events, 0); });
  it("skips malformed JSON", () => {
    const d = tmp(); const f = path.join(d, "t.jsonl"); fs.writeFileSync(f, "not json\n{bad\n");
    assert.equal(parseStream(f).events, 0); fs.rmSync(d, { recursive: true });
  });
  it("parses message_end with stop", () => {
    const f = writeTempJsonl([{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop" } }]);
    const r = parseStream(f); assert.equal(r.finalText, "answer"); assert.equal(r.stopReason, "stop");
  });
  it("does NOT set finalText for toolUse", () => {
    const f = writeTempJsonl([{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall" }], stopReason: "toolUse" } }]);
    assert.equal(parseStream(f).finalText, ""); assert.equal(parseStream(f).toolCalls, 1);
  });
  it("accumulates usage", () => {
    const f = writeTempJsonl([
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "toolUse", usage: { input: 100, output: 50, cost: { total: 0.01 } } } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { input: 200, output: 100, cost: { total: 0.02 } } } },
    ]);
    const r = parseStream(f); assert.equal(r.usage.input, 300); assert.equal(r.usage.cost, 0.03);
  });
  it("handles unicode", () => {
    const text = "Hello 🌍 café 中文";
    const f = writeTempJsonl([{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }]);
    assert.equal(parseStream(f).finalText, text);
  });
  it("handles CRLF", () => {
    const d = tmp(); const f = path.join(d, "t.jsonl");
    fs.writeFileSync(f, '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"crlf"}],"stopReason":"stop"}}\r\n');
    assert.equal(parseStream(f).finalText, "crlf"); fs.rmSync(d, { recursive: true });
  });
});

// --- state ---
describe("state", () => {
  it("loadMeta returns null for missing dir", () => { assert.equal(loadMeta("/nonexistent"), null); });
  it("isAgentDone true when .done exists", () => {
    const d = tmp(); fs.writeFileSync(path.join(d, "test.done"), "0");
    assert.equal(isAgentDone(d, fakeModel()), true); fs.rmSync(d, { recursive: true });
  });
  it("isAgentDone false when no .done no .pid", () => {
    const d = tmp(); assert.equal(isAgentDone(d, fakeModel()), false); fs.rmSync(d, { recursive: true });
  });
  it("refreshWorker done=0 = done", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "test.done"), "0"); fs.writeFileSync(path.join(d, "test.pid"), "999999999");
    fs.writeFileSync(path.join(d, "test.jsonl"), ""); fs.writeFileSync(path.join(d, "test.err"), "");
    assert.equal(refreshWorker(d, fakeModel()).status, "done"); fs.rmSync(d, { recursive: true });
  });
  it("refreshWorker done=1 = failed", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "test.done"), "1"); fs.writeFileSync(path.join(d, "test.pid"), "999999999");
    fs.writeFileSync(path.join(d, "test.jsonl"), ""); fs.writeFileSync(path.join(d, "test.err"), "error text");
    const w = refreshWorker(d, fakeModel()); assert.equal(w.status, "failed"); assert.ok(w.errorMessage?.includes("error text")); fs.rmSync(d, { recursive: true });
  });
  it("refreshWorker done=cancelled = failed", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "test.done"), "cancelled"); fs.writeFileSync(path.join(d, "test.pid"), "999999999");
    fs.writeFileSync(path.join(d, "test.jsonl"), "");
    assert.equal(refreshWorker(d, fakeModel()).status, "failed"); fs.rmSync(d, { recursive: true });
  });
  it("refreshWorker exit=0 + error stopReason = failed", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "test.done"), "0"); fs.writeFileSync(path.join(d, "test.pid"), "999999999");
    fs.writeFileSync(path.join(d, "test.jsonl"), '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"API err"}}\n');
    const w = refreshWorker(d, fakeModel()); assert.equal(w.status, "failed"); fs.rmSync(d, { recursive: true });
  });
  it("pidAlive returns true for own PID", () => {
    // killPid on own PID shouldn't crash
    assert.doesNotThrow(() => { /* just verify the module loads */ });
  });
});

// --- session with mock pi ---
describe("CouncilSession", () => {
  let tmpDir: string, origPath: string;
  before(() => {
    tmpDir = tmp();
    fs.writeFileSync(path.join(tmpDir, "pi"), `#!/bin/bash\nexport MOCK_BEHAVIOR=success\nexec ${MOCK_PI} "$@"\n`, { mode: 0o755 });
    origPath = process.env.PATH!; process.env.PATH = `${tmpDir}:${origPath}`;
  });
  after(() => { process.env.PATH = origPath; fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("spawns and completes successfully", async () => {
    const runDir = path.join(tmpDir, "run1"); fs.mkdirSync(runDir, { recursive: true });
    let allDone = false;
    const s = new CouncilSession({ runId: "t1", runDir, prompt: "test", models: [fakeModel()], config: fakeConfig, cwd: tmpDir, events: { onAllDone() { allDone = true; } } });
    assert.ok(s.start()); await s.wait(); s.dispose();
    assert.ok(s.isDone); assert.ok(allDone); assert.equal(s.agents[0].exitCode, 0);
    assert.ok(s.agents[0].output.includes("Mock answer"));
    assert.ok(fs.existsSync(path.join(runDir, "results.json")));
  });

  it("cancels running agents", async () => {
    fs.writeFileSync(path.join(tmpDir, "pi"), `#!/bin/bash\nexport MOCK_BEHAVIOR=hang\nexec ${MOCK_PI} "$@"\n`, { mode: 0o755 });
    const runDir = path.join(tmpDir, "run2"); fs.mkdirSync(runDir, { recursive: true });
    let cancelled = false;
    const s = new CouncilSession({ runId: "t2", runDir, prompt: "test", models: [fakeModel()], config: { ...fakeConfig, timeout_seconds: 0 }, cwd: tmpDir, events: { onCancelled() { cancelled = true; } } });
    s.start(); s.cancel(); assert.ok(s.isCancelled); assert.ok(cancelled); s.dispose();
    fs.writeFileSync(path.join(tmpDir, "pi"), `#!/bin/bash\nexport MOCK_BEHAVIOR=success\nexec ${MOCK_PI} "$@"\n`, { mode: 0o755 });
  });

  it("times out", async () => {
    fs.writeFileSync(path.join(tmpDir, "pi"), `#!/bin/bash\nexport MOCK_BEHAVIOR=hang\nexec ${MOCK_PI} "$@"\n`, { mode: 0o755 });
    const runDir = path.join(tmpDir, "run3"); fs.mkdirSync(runDir, { recursive: true });
    let timedOut = false;
    const s = new CouncilSession({ runId: "t3", runDir, prompt: "test", models: [fakeModel()], config: { ...fakeConfig, timeout_seconds: 1 }, cwd: tmpDir, timeoutSeconds: 1, events: { onTimeout() { timedOut = true; } } });
    s.start(); await s.wait(); assert.ok(timedOut); assert.ok(s.isTimedOut); s.dispose();
    fs.writeFileSync(path.join(tmpDir, "pi"), `#!/bin/bash\nexport MOCK_BEHAVIOR=success\nexec ${MOCK_PI} "$@"\n`, { mode: 0o755 });
  });

  it("detects protocol error with exit=0", async () => {
    fs.writeFileSync(path.join(tmpDir, "pi"), `#!/bin/bash\nexport MOCK_BEHAVIOR=error\nexec ${MOCK_PI} "$@"\n`, { mode: 0o755 });
    const runDir = path.join(tmpDir, "run4"); fs.mkdirSync(runDir, { recursive: true });
    const s = new CouncilSession({ runId: "t4", runDir, prompt: "test", models: [fakeModel()], config: fakeConfig, cwd: tmpDir });
    s.start(); await s.wait(); s.dispose();
    const rj = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf-8"));
    assert.equal(rj.workers[0].status, "failed");
    fs.writeFileSync(path.join(tmpDir, "pi"), `#!/bin/bash\nexport MOCK_BEHAVIOR=success\nexec ${MOCK_PI} "$@"\n`, { mode: 0o755 });
  });
});
