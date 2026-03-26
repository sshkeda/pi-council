import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { resolveModels, DEFAULT_MODELS } from "../src/core/config.js";

const config = {
  models: DEFAULT_MODELS,
  tools: "bash,read",
  timeout_seconds: 600,
  system_prompt: "test",
};

describe("resolveModels", () => {
  it("returns all models when no filter", () => {
    assert.equal(resolveModels(config).length, DEFAULT_MODELS.length);
  });
  it("returns all models when empty array", () => {
    assert.equal(resolveModels(config, []).length, DEFAULT_MODELS.length);
  });
  it("filters to specific models", () => {
    const r = resolveModels(config, ["claude", "grok"]);
    assert.equal(r.length, 2);
  });
  it("is case-insensitive", () => {
    assert.equal(resolveModels(config, ["CLAUDE"]).length, 1);
  });
  it("throws on unknown model", () => {
    assert.throws(() => resolveModels(config, ["unknown"]), /Unknown model/);
  });
});
