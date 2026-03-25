import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

// We can't easily import parseArgs (it's not exported), so we test via CLI behavior
// Instead, test the exported commands' input validation

describe("CLI arg parsing", () => {
  it("should exist and be importable", async () => {
    // Just verify the module loads without errors
    const mod = await import("../src/commands/ask.js");
    assert.equal(typeof mod.ask, "function");
  });

  it("ask throws on empty models", async () => {
    const { ask } = await import("../src/commands/ask.js");
    await assert.rejects(
      () => ask("test", { models: [] }),
      /No models selected/,
    );
  });
});
