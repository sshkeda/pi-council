import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { generateResultsMd, generateResultsJson, writeArtifacts, type WorkerResult } from "../src/core/artifacts.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-artifacts-"));
}

const mockWorker: WorkerResult = {
  id: "claude",
  provider: "anthropic",
  model: "claude-test",
  status: "done",
  finalText: "Test response",
  errorMessage: null,
  usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
};

const mockData = {
  runId: "test-run-123",
  prompt: "What is 2+2?",
  workers: [mockWorker],
};

describe("generateResultsMd", () => {
  it("generates valid markdown with run info", () => {
    const md = generateResultsMd(mockData);
    assert.ok(md.includes("test-run-123"));
    assert.ok(md.includes("What is 2+2?"));
    assert.ok(md.includes("claude"));
    assert.ok(md.includes("Test response"));
    assert.ok(md.includes("$0.0100"));
  });

  it("handles failed workers", () => {
    const failed: WorkerResult = { ...mockWorker, status: "failed", finalText: "", errorMessage: "API error" };
    const md = generateResultsMd({ ...mockData, workers: [failed] });
    assert.ok(md.includes("API error"));
  });
});

describe("generateResultsJson", () => {
  it("generates valid JSON with correct schema", () => {
    const json = JSON.parse(generateResultsJson(mockData));
    assert.equal(json.runId, "test-run-123");
    assert.equal(json.prompt, "What is 2+2?");
    assert.ok(json.completedAt > 0);
    assert.equal(json.workers.length, 1);
    assert.equal(json.workers[0].id, "claude");
    assert.equal(json.workers[0].provider, "anthropic");
    assert.equal(json.workers[0].status, "done");
    assert.equal(json.workers[0].finalText, "Test response");
    assert.equal(json.workers[0].usage.input, 100);
  });
});

describe("writeArtifacts", () => {
  it("writes results.md and results.json to disk", () => {
    const dir = makeTmpDir();
    writeArtifacts(dir, mockData);

    assert.ok(fs.existsSync(path.join(dir, "results.md")));
    assert.ok(fs.existsSync(path.join(dir, "results.json")));

    const json = JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf-8"));
    assert.equal(json.runId, "test-run-123");

    const md = fs.readFileSync(path.join(dir, "results.md"), "utf-8");
    assert.ok(md.includes("Test response"));

    fs.rmSync(dir, { recursive: true });
  });

  it("handles write errors gracefully", () => {
    // Writing to a non-existent directory should not throw
    assert.doesNotThrow(() => {
      writeArtifacts("/nonexistent/path/that/does/not/exist", mockData);
    });
  });
});
