import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseStream } from "../src/core/runner.js";
import { loadMeta, refreshWorker, isAgentDone } from "../src/core/state.js";
import { CouncilSession } from "../src/core/session.js";
import type { Config, ModelSpec } from "../src/core/config.js";

const MOCK_PI = path.resolve("test/fixtures/mock-pi.sh");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-test-"));
const fakeModel = (id = "test"): ModelSpec => ({ id, provider: "mock", model: "mock-1" });
const fakeConfig: Config = { models: [fakeModel()], tools: "bash", timeout_seconds: 5, system_prompt: "test" };

function writeTempJsonl(lines: object[]): string {
  const dir = tmp(); const f = path.join(dir, "test.jsonl");
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join("\n") + "\n"); return f;
}

function setupMock(behavior: string): { tmpDir: string; cleanup: () => void } {
  const tmpDir = tmp();
  fs.writeFileSync(path.join(tmpDir, "pi"),
    `#!/bin/bash\nexport MOCK_BEHAVIOR=${behavior}\nexec ${MOCK_PI} "$@"\n`,
    { mode: 0o755 });
  const origPath = process.env.PATH!;
  process.env.PATH = `${tmpDir}:${origPath}`;
  return { tmpDir, cleanup: () => { process.env.PATH = origPath; fs.rmSync(tmpDir, { recursive: true, force: true }); } };
}

describe("parseStream", () => {
  it("returns empty for missing file", () => { assert.equal(parseStream("/nonexistent").events, 0); });
  it("skips malformed JSON", () => { const d = tmp(); const f = path.join(d, "t.jsonl"); fs.writeFileSync(f, "bad\n"); assert.equal(parseStream(f).events, 0); fs.rmSync(d, { recursive: true }); });
  it("parses message_end with stop", () => {
    const f = writeTempJsonl([{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop" } }]);
    assert.equal(parseStream(f).finalText, "answer");
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
    assert.equal(parseStream(f).usage.input, 300);
  });
  it("handles unicode", () => {
    const f = writeTempJsonl([{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "🌍 café" }], stopReason: "stop" } }]);
    assert.equal(parseStream(f).finalText, "🌍 café");
  });
});

describe("state", () => {
  it("loadMeta null for missing", () => { assert.equal(loadMeta("/x"), null); });
  it("isAgentDone true with .done", () => { const d = tmp(); fs.writeFileSync(path.join(d, "test.done"), "0"); assert.ok(isAgentDone(d, fakeModel())); fs.rmSync(d, { recursive: true }); });
  it("isAgentDone false without .done/.pid", () => { const d = tmp(); assert.ok(!isAgentDone(d, fakeModel())); fs.rmSync(d, { recursive: true }); });
  it("refreshWorker done=0 → done", () => {
    const d = tmp(); fs.writeFileSync(path.join(d, "test.done"), "0"); fs.writeFileSync(path.join(d, "test.pid"), "999999999"); fs.writeFileSync(path.join(d, "test.jsonl"), ""); fs.writeFileSync(path.join(d, "test.err"), "");
    assert.equal(refreshWorker(d, fakeModel()).status, "done"); fs.rmSync(d, { recursive: true });
  });
  it("refreshWorker done=1 → failed", () => {
    const d = tmp(); fs.writeFileSync(path.join(d, "test.done"), "1"); fs.writeFileSync(path.join(d, "test.pid"), "999999999"); fs.writeFileSync(path.join(d, "test.jsonl"), ""); fs.writeFileSync(path.join(d, "test.err"), "err");
    assert.equal(refreshWorker(d, fakeModel()).status, "failed"); fs.rmSync(d, { recursive: true });
  });
  it("refreshWorker cancelled → failed", () => {
    const d = tmp(); fs.writeFileSync(path.join(d, "test.done"), "cancelled"); fs.writeFileSync(path.join(d, "test.pid"), "999999999"); fs.writeFileSync(path.join(d, "test.jsonl"), "");
    assert.equal(refreshWorker(d, fakeModel()).status, "failed"); fs.rmSync(d, { recursive: true });
  });
  it("refreshWorker exit=0+error → failed", () => {
    const d = tmp(); fs.writeFileSync(path.join(d, "test.done"), "0"); fs.writeFileSync(path.join(d, "test.pid"), "999999999");
    fs.writeFileSync(path.join(d, "test.jsonl"), '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"API err"}}\n');
    assert.equal(refreshWorker(d, fakeModel()).status, "failed"); fs.rmSync(d, { recursive: true });
  });
});

describe("CouncilSession", () => {
  it("spawns and completes", async () => {
    const { tmpDir, cleanup } = setupMock("success");
    try {
      const runDir = path.join(tmpDir, "run"); fs.mkdirSync(runDir, { recursive: true });
      const s = new CouncilSession({ runId: "t1", runDir, prompt: "test", models: [fakeModel()], config: fakeConfig, cwd: tmpDir });
      assert.ok(s.start()); await s.wait(); s.dispose();
      assert.ok(s.isDone); assert.equal(s.agents[0].exitCode, 0);
      assert.ok(s.agents[0].output.includes("Mock"));
      assert.ok(fs.existsSync(path.join(runDir, "results.json")));
    } finally { cleanup(); }
  });

  it("cancels agents", async () => {
    const { tmpDir, cleanup } = setupMock("hang");
    try {
      const runDir = path.join(tmpDir, "run"); fs.mkdirSync(runDir, { recursive: true });
      const s = new CouncilSession({ runId: "t2", runDir, prompt: "test", models: [fakeModel()], config: { ...fakeConfig, timeout_seconds: 0 }, cwd: tmpDir });
      s.start(); s.cancel(); assert.ok(s.isCancelled); s.dispose();
    } finally { cleanup(); }
  });

  it("times out", async () => {
    const { tmpDir, cleanup } = setupMock("hang");
    try {
      const runDir = path.join(tmpDir, "run"); fs.mkdirSync(runDir, { recursive: true });
      let timedOut = false;
      const s = new CouncilSession({ runId: "t3", runDir, prompt: "test", models: [fakeModel()], config: fakeConfig, cwd: tmpDir, timeoutSeconds: 1, events: { onTimeout() { timedOut = true; } } });
      s.start(); await s.wait(); assert.ok(timedOut); assert.ok(s.isTimedOut); s.dispose();
    } finally { cleanup(); }
  });

  it("detects protocol error with exit=0", async () => {
    const { tmpDir, cleanup } = setupMock("error");
    try {
      const runDir = path.join(tmpDir, "run"); fs.mkdirSync(runDir, { recursive: true });
      const s = new CouncilSession({ runId: "t4", runDir, prompt: "test", models: [fakeModel()], config: fakeConfig, cwd: tmpDir });
      s.start(); await s.wait(); s.dispose();
      const rj = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf-8"));
      assert.equal(rj.workers[0].status, "failed");
    } finally { cleanup(); }
  });
});
