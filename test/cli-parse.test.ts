import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

// Test CLI module loads without side effects
describe("CLI module", () => {
  it("ask function is importable", async () => {
    const mod = await import("../src/commands/ask.js");
    assert.equal(typeof mod.ask, "function");
  });

  it("spawn function is importable", async () => {
    const mod = await import("../src/commands/spawn.js");
    assert.equal(typeof mod.spawn, "function");
  });

  it("resolveModels throws on empty filter with explicit empty array", async () => {
    const { resolveModels } = await import("../src/core/config.js");
    const config = {
      models: [{ id: "test", provider: "test", model: "test-model" }],
      tools: "bash,read",
      stall_seconds: 60,
      timeout_seconds: 300,
      system_prompt: "test",
    };
    // Empty array returns all models (not an error)
    const result = resolveModels(config, []);
    assert.equal(result.length, 1);
  });
});
