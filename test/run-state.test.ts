import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadMeta, isAgentDone, refreshWorker, type RunMeta } from "../src/core/run-state.js";
import type { ModelSpec } from "../src/core/config.js";

function makeTmpRunDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-test-run-"));
  return dir;
}

const fakeModel: ModelSpec = { id: "test", provider: "test", model: "test-model" };

describe("loadMeta", () => {
  it("returns null for missing directory", () => {
    assert.equal(loadMeta("/nonexistent/path"), null);
  });

  it("returns null for missing meta.json", () => {
    const dir = makeTmpRunDir();
    assert.equal(loadMeta(dir), null);
    fs.rmSync(dir, { recursive: true });
  });

  it("returns null for corrupted meta.json", () => {
    const dir = makeTmpRunDir();
    fs.writeFileSync(path.join(dir, "meta.json"), "not json");
    assert.equal(loadMeta(dir), null);
    fs.rmSync(dir, { recursive: true });
  });

  it("loads valid meta.json", () => {
    const dir = makeTmpRunDir();
    const meta: RunMeta = { runId: "test-123", prompt: "hello", startedAt: Date.now(), agents: [fakeModel], cwd: "/tmp" };
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
    const loaded = loadMeta(dir);
    assert.ok(loaded);
    assert.equal(loaded.runId, "test-123");
    assert.equal(loaded.prompt, "hello");
    fs.rmSync(dir, { recursive: true });
  });
});

describe("isAgentDone", () => {
  it("returns true when .done file exists", () => {
    const dir = makeTmpRunDir();
    fs.writeFileSync(path.join(dir, "test.done"), "0");
    assert.equal(isAgentDone(dir, fakeModel), true);
    fs.rmSync(dir, { recursive: true });
  });

  it("returns false when no .done and no .pid", () => {
    const dir = makeTmpRunDir();
    // No PID file — can't determine state, return false (caller handles this)
    assert.equal(isAgentDone(dir, fakeModel), false);
    fs.rmSync(dir, { recursive: true });
  });

  it("marks done when PID file points to dead process", () => {
    const dir = makeTmpRunDir();
    // Use a PID that almost certainly doesn't exist
    fs.writeFileSync(path.join(dir, "test.pid"), "999999999");
    assert.equal(isAgentDone(dir, fakeModel), true);
    // Should have created .done file as side effect
    assert.ok(fs.existsSync(path.join(dir, "test.done")));
    fs.rmSync(dir, { recursive: true });
  });
});

describe("refreshWorker", () => {
  it("returns failed status for completed worker with no output", () => {
    const dir = makeTmpRunDir();
    fs.writeFileSync(path.join(dir, "test.done"), "1");
    fs.writeFileSync(path.join(dir, "test.jsonl"), "");
    fs.writeFileSync(path.join(dir, "test.err"), "some error");
    fs.writeFileSync(path.join(dir, "test.pid"), "999999999");

    const state = refreshWorker(dir, fakeModel, 60);
    assert.equal(state.status, "failed");
    assert.equal(state.id, "test");
    assert.ok(state.errorMessage?.includes("some error"));
    fs.rmSync(dir, { recursive: true });
  });

  it("returns done status for completed worker with exit code 0", () => {
    const dir = makeTmpRunDir();
    fs.writeFileSync(path.join(dir, "test.done"), "0");
    fs.writeFileSync(path.join(dir, "test.jsonl"), "");
    fs.writeFileSync(path.join(dir, "test.pid"), "999999999");

    const state = refreshWorker(dir, fakeModel, 60);
    assert.equal(state.status, "done");
    fs.rmSync(dir, { recursive: true });
  });

  it("returns cancelled as failed", () => {
    const dir = makeTmpRunDir();
    fs.writeFileSync(path.join(dir, "test.done"), "cancelled");
    fs.writeFileSync(path.join(dir, "test.jsonl"), JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "stop" },
    }) + "\n");
    fs.writeFileSync(path.join(dir, "test.pid"), "999999999");

    const state = refreshWorker(dir, fakeModel, 60);
    assert.equal(state.status, "failed");
    fs.rmSync(dir, { recursive: true });
  });
});

import { resolveRunId } from "../src/commands/status.js";

describe("resolveRunId", () => {
  it("rejects path traversal in run ID", () => {
    assert.throws(() => resolveRunId("../../../etc/passwd"), /Invalid run ID/);
    assert.throws(() => resolveRunId("foo/bar"), /Invalid run ID/);
    assert.throws(() => resolveRunId("foo\\bar"), /Invalid run ID/);
  });

  it("accepts valid run IDs", () => {
    // Won't find the run but shouldn't throw validation error
    // (will throw "No run found" instead)
    assert.doesNotThrow(() => {
      try { resolveRunId("20260325-123456-abcd1234"); } catch (e) {
        if ((e as Error).message.includes("Invalid")) throw e;
      }
    });
  });
});

describe("Bugfix: exitCode=0 with error stopReason in refreshWorker", () => {
  it("treats exit=0 with stopReason=error as failed", () => {
    const dir = makeTmpRunDir();
    fs.writeFileSync(path.join(dir, "test.done"), "0");
    fs.writeFileSync(path.join(dir, "test.pid"), "999999999");
    fs.writeFileSync(path.join(dir, "test.jsonl"), 
      '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"API error"}}\n');
    const state = refreshWorker(dir, fakeModel, 60);
    assert.equal(state.status, "failed");
    assert.ok(state.errorMessage?.includes("API error"));
    fs.rmSync(dir, { recursive: true });
  });
});
