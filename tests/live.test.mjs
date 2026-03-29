#!/usr/bin/env node

/**
 * Live sandboxed tests — real API calls against gpt-5.4-mini.
 *
 * Validates the full pipeline end-to-end: config → profile resolution →
 * council spawn → pi RPC → real model → output.
 *
 * Uses a temporary HOME so no host config leaks in.
 * Requires OPENAI_API_KEY in the environment.
 *
 * Run: node tests/live.test.mjs
 */

import { Council } from "../dist/src/core/council.js";
import { getDefaultConfig, resolveProfile, saveConfig, getConfigPath } from "../dist/src/core/config.js";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function test(name, fn, timeoutMs = 60000) {
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), timeoutMs)),
    ]);
    passed++;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`  ❌ ${name}: ${err.message}\n`);
  }
}

// ─── Setup ───────────────────────────────────────────────────────────

// Preserve pi's agent dir so it can find auth.json / models.json
const realAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
if (!existsSync(join(realAgentDir, "auth.json"))) {
  process.stderr.write(`⚠️  No auth.json found at ${realAgentDir} — skipping live tests\n`);
  process.exit(0);
}

// Isolate HOME for council config/runs, but keep pi's agent dir
const testHome = mkdtempSync(join(tmpdir(), "pi-council-live-test-"));
process.env.HOME = testHome;
process.env.PI_CODING_AGENT_DIR = realAgentDir;

// The test model — cheap and fast
const TEST_MODEL = { id: "gpt-mini", provider: "openai-codex", model: "gpt-5.4-mini" };

// Write config with test profiles
const config = {
  models: {
    "gpt-mini": { provider: TEST_MODEL.provider, model: TEST_MODEL.model },
  },
  profiles: {
    default: { models: ["gpt-mini"] },
    brief: {
      models: ["gpt-mini"],
      systemPrompt: "Answer in exactly one word.",
    },
    thinker: {
      models: ["gpt-mini"],
      thinking: "low",
    },
  },
  defaultProfile: "default",
  systemPrompt: "You are one member of a multi-model council. Be concise.",
};
saveConfig(config);

process.stdout.write("\n🔴 Live Tests (gpt-5.4-mini)\n\n");

// ─── Tests ───────────────────────────────────────────────────────────

await test("L1: Single model council completes with output", async () => {
  const council = new Council("What is 2+2? Reply with just the number.");
  council.spawn({ models: [TEST_MODEL] });

  const result = await council.waitForCompletion();
  assert(result.members.length === 1, "1 member");
  assert(result.members[0].state === "done", `state: ${result.members[0].state}`);
  assert(result.members[0].output.length > 0, "has output");
  assert(result.members[0].durationMs > 0, "has duration");
});

await test("L2: Profile systemPrompt affects model behavior", async () => {
  const resolved = resolveProfile(config, "brief");
  const council = new Council("What color is the sky?");
  council.spawn({
    models: resolved.models,
    systemPrompt: resolved.systemPrompt,
  });

  const result = await council.waitForCompletion();
  const output = result.members[0].output.trim();
  // "Answer in exactly one word" — output should be very short
  assert(output.split(/\s+/).length <= 5, `brief output (${output.length} chars): ${output}`);
});

await test("L3: Profile with thinking level completes", async () => {
  const resolved = resolveProfile(config, "thinker");
  const council = new Council("What is the square root of 144?");
  council.spawn({
    models: resolved.models,
    systemPrompt: resolved.systemPrompt,
    thinking: resolved.thinking,
  });

  const result = await council.waitForCompletion();
  assert(result.members[0].state === "done", "done");
  assert(result.members[0].output.length > 0, "has output");
});

await test("L4: Council writes artifacts to disk", async () => {
  const council = new Council("Say hello.");
  council.spawn({ models: [TEST_MODEL] });

  const result = await council.waitForCompletion();
  const runDir = council.getRunDir();
  assert(existsSync(join(runDir, "meta.json")), "meta.json");
  assert(existsSync(join(runDir, "prompt.txt")), "prompt.txt");
  assert(existsSync(join(runDir, "results.json")), "results.json");
  assert(existsSync(join(runDir, "results.md")), "results.md");
  assert(existsSync(join(runDir, "gpt-mini.json")), "gpt-mini.json");
});

await test("L5: Two member council both complete", async () => {
  const council = new Council("Is water wet? One sentence.");
  council.spawn({
    models: [
      { id: "a", provider: TEST_MODEL.provider, model: TEST_MODEL.model },
      { id: "b", provider: TEST_MODEL.provider, model: TEST_MODEL.model },
    ],
  });

  const result = await council.waitForCompletion();
  assert(result.members.length === 2, "2 members");
  assert(result.members.every(m => m.state === "done"), "all done");
  assert(result.members.every(m => m.output.length > 0), "all have output");
  assert(result.ttfrMs > 0, "has ttfr");
});

await test("L6: Cancel mid-flight works", async () => {
  const council = new Council("Write a 500 word essay about clouds.");
  council.spawn({ models: [TEST_MODEL] });

  // Wait a moment then cancel
  await new Promise(r => setTimeout(r, 2000));
  council.cancel();

  const result = await council.waitForCompletion();
  assert(result.members[0].state === "cancelled", `state: ${result.members[0].state}`);
});

// ─── Done ────────────────────────────────────────────────────────────

process.stdout.write(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed}\n`);
process.stdout.write(`\nMETRIC tests_passed=${passed}\n`);
process.stdout.write(`METRIC tests_failed=${failed}\n`);
process.exitCode = failed > 0 ? 1 : 0;
