import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseArgs } from "../src/cli.js";

// parseArgs expects process.argv format: [node, script, ...args]
const argv = (...args: string[]) => ["node", "cli.js", ...args];

describe("parseArgs", () => {
  it("defaults to help with no args", () => {
    const r = parseArgs(argv());
    assert.equal(r.command, "help");
    assert.equal(r.prompt, "");
  });

  it("parses ask command with prompt", () => {
    const r = parseArgs(argv("ask", "review this code"));
    assert.equal(r.command, "ask");
    assert.equal(r.prompt, "review this code");
  });

  it("parses implicit ask when no command matches", () => {
    const r = parseArgs(argv("what is 2+2"));
    assert.equal(r.command, "ask");
    assert.equal(r.prompt, "what is 2+2");
  });

  it("parses --models flag before command", () => {
    const r = parseArgs(argv("--models", "claude,grok", "ask", "test"));
    assert.equal(r.command, "ask");
    assert.deepEqual(r.models, ["claude", "grok"]);
    assert.equal(r.prompt, "test");
  });

  it("parses --models flag after command", () => {
    const r = parseArgs(argv("ask", "--models", "gpt", "test"));
    assert.equal(r.command, "ask");
    assert.deepEqual(r.models, ["gpt"]);
    assert.equal(r.prompt, "test");
  });

  it("filters empty model names from --models", () => {
    const r = parseArgs(argv("--models", ",claude,,gpt,", "ask", "test"));
    assert.deepEqual(r.models, ["claude", "gpt"]);
  });

  it("parses --timeout flag", () => {
    const r = parseArgs(argv("ask", "--timeout", "120", "test"));
    assert.equal(r.timeout, 120);
  });

  it("ignores invalid --timeout", () => {
    const r = parseArgs(argv("ask", "--timeout", "abc", "test"));
    assert.equal(r.timeout, undefined);
  });

  it("parses --cwd flag", () => {
    const r = parseArgs(argv("ask", "--cwd", "/tmp", "test"));
    assert.equal(r.cwd, "/tmp");
  });

  it("parses -h as help", () => {
    const r = parseArgs(argv("-h"));
    assert.equal(r.command, "help");
  });

  it("parses -v as version", () => {
    const r = parseArgs(argv("-v"));
    assert.equal(r.command, "version");
  });

  it("parses status with run-id", () => {
    const r = parseArgs(argv("status", "20260325-123456-abcd1234"));
    assert.equal(r.command, "status");
    assert.equal(r.runId, "20260325-123456-abcd1234");
  });

  it("parses spawn command", () => {
    const r = parseArgs(argv("spawn", "analyze MSFT"));
    assert.equal(r.command, "spawn");
    assert.equal(r.prompt, "analyze MSFT");
  });

  it("parses cleanup command", () => {
    const r = parseArgs(argv("cleanup", "20260325-123456-abcd1234"));
    assert.equal(r.command, "cleanup");
    assert.equal(r.runId, "20260325-123456-abcd1234");
  });

  it("parses list command", () => {
    const r = parseArgs(argv("list"));
    assert.equal(r.command, "list");
  });

  it("combines multiple prompt words", () => {
    const r = parseArgs(argv("ask", "should", "I", "refactor"));
    assert.equal(r.prompt, "should I refactor");
  });
});

describe("parseArgs --run-id flag", () => {
  it("parses --run-id flag", () => {
    const r = parseArgs(argv("status", "--run-id", "20260325-123456-abcd1234"));
    assert.equal(r.command, "status");
    assert.equal(r.runId, "20260325-123456-abcd1234");
  });

  it("--run-id takes precedence over positional", () => {
    const r = parseArgs(argv("status", "--run-id", "flagged-id", "20260325-999999-pos"));
    assert.equal(r.runId, "flagged-id");
  });
});

describe("parseArgs security", () => {
  it("parses --run-id with non-date format", () => {
    const r = parseArgs(argv("status", "--run-id", "custom-id"));
    assert.equal(r.runId, "custom-id");
  });
});

describe("parseArgs command-in-prompt safety", () => {
  it("does not treat 'status' in middle of prompt as command", () => {
    const r = parseArgs(argv("check the status of this"));
    assert.equal(r.command, "ask");
    assert.equal(r.prompt, "check the status of this");
  });

  it("first token 'watch' as separate arg IS a command", () => {
    const r = parseArgs(argv("watch", "out", "for", "bugs"));
    assert.equal(r.command, "watch");
  });

  it("'watch' inside a single quoted prompt is NOT a command", () => {
    const r = parseArgs(argv("watch out for bugs"));
    // Single string arg — "watch out for bugs" is not a known command
    assert.equal(r.command, "ask");
    assert.equal(r.prompt, "watch out for bugs");
  });

  it("treats first token as command only", () => {
    const r = parseArgs(argv("tell me the list of issues"));
    assert.equal(r.command, "ask");
    assert.ok(r.prompt.includes("list"));
  });
});

describe("parseArgs -- end of flags", () => {
  it("treats everything after -- as prompt", () => {
    const r = parseArgs(argv("ask", "--", "--models", "is a weird topic"));
    assert.equal(r.command, "ask");
    assert.equal(r.prompt, "--models is a weird topic");
    assert.equal(r.models, undefined);
  });
});

describe("parseArgs --timeout 0", () => {
  it("accepts --timeout 0 to disable timeout", () => {
    const r = parseArgs(argv("ask", "--timeout", "0", "test"));
    assert.equal(r.timeout, 0);
  });
});
