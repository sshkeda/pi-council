import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { resolveModels, DEFAULT_MODELS } from "../src/core/config.js";

const config = {
  models: DEFAULT_MODELS,
  tools: "bash,read",
  stall_seconds: 60,
  timeout_seconds: 300,
  system_prompt: "test",
};

describe("resolveModels", () => {
  it("returns all models when no filter", () => {
    const result = resolveModels(config);
    assert.equal(result.length, DEFAULT_MODELS.length);
  });

  it("returns all models when filter is empty array", () => {
    const result = resolveModels(config, []);
    assert.equal(result.length, DEFAULT_MODELS.length);
  });

  it("filters to specific models", () => {
    const result = resolveModels(config, ["claude", "grok"]);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, "claude");
    assert.equal(result[1].id, "grok");
  });

  it("is case-insensitive", () => {
    const result = resolveModels(config, ["CLAUDE", "GPT"]);
    assert.equal(result.length, 2);
  });

  it("throws on unknown model", () => {
    assert.throws(() => resolveModels(config, ["claude", "unknown"]), /Unknown model\(s\): unknown/);
  });

  it("throws listing available models", () => {
    assert.throws(() => resolveModels(config, ["bad"]), /Available:/);
  });
});
