import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseStream } from "../src/core/stream-parser.js";

function writeTempJsonl(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-test-"));
  const file = path.join(dir, "test.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

describe("parseStream", () => {
  it("returns empty result for missing file", () => {
    const result = parseStream("/nonexistent/path.jsonl");
    assert.equal(result.finalText, "");
    assert.equal(result.assistantText, "");
    assert.equal(result.events, 0);
    assert.equal(result.toolCalls, 0);
  });

  it("returns empty result for empty file", () => {
    const file = writeTempJsonl([]);
    fs.writeFileSync(file, "");
    const result = parseStream(file);
    assert.equal(result.events, 0);
    assert.equal(result.finalText, "");
  });

  it("skips malformed JSON lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-test-"));
    const file = path.join(dir, "test.jsonl");
    fs.writeFileSync(file, "not json\n{bad\n");
    const result = parseStream(file);
    assert.equal(result.events, 0);
  });

  it("parses message_update with assistant text", () => {
    const file = writeTempJsonl([
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        },
      },
    ]);
    const result = parseStream(file);
    assert.equal(result.events, 1);
    assert.equal(result.assistantText, "Hello world");
    assert.equal(result.finalText, ""); // not a final message
  });

  it("parses message_end with stopReason=stop as final text", () => {
    const file = writeTempJsonl([
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Final answer" }],
          stopReason: "stop",
        },
      },
    ]);
    const result = parseStream(file);
    assert.equal(result.finalText, "Final answer");
    assert.equal(result.stopReason, "stop");
  });

  it("does NOT set finalText for toolUse stopReason", () => {
    const file = writeTempJsonl([
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check" },
            { type: "toolCall" },
          ],
          stopReason: "toolUse",
        },
      },
    ]);
    const result = parseStream(file);
    assert.equal(result.finalText, "");
    assert.equal(result.assistantText, "Let me check");
    assert.equal(result.toolCalls, 1);
  });

  it("accumulates usage across multiple message_end events", () => {
    const file = writeTempJsonl([
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall" }],
          stopReason: "toolUse",
          usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 0.01 } },
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
          stopReason: "stop",
          usage: { input: 200, output: 100, cacheRead: 20, cacheWrite: 10, cost: { total: 0.02 } },
        },
      },
    ]);
    const result = parseStream(file);
    assert.equal(result.usage.input, 300);
    assert.equal(result.usage.output, 150);
    assert.equal(result.usage.cacheRead, 30);
    assert.equal(result.usage.cacheWrite, 15);
    assert.equal(result.usage.cost, 0.03);
    assert.equal(result.finalText, "Done");
    assert.equal(result.toolCalls, 1);
  });

  it("handles missing usage fields gracefully", () => {
    const file = writeTempJsonl([
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stopReason: "stop",
          usage: {},
        },
      },
    ]);
    const result = parseStream(file);
    assert.equal(result.usage.input, 0);
    assert.equal(result.usage.cost, 0);
  });

  it("extracts errorMessage from message_end", () => {
    const file = writeTempJsonl([
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "API rate limited",
        },
      },
    ]);
    const result = parseStream(file);
    assert.equal(result.errorMessage, "API rate limited");
  });
});
