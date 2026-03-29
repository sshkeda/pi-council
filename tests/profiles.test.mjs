#!/usr/bin/env node

/**
 * Profile tests — pi-mock integration tests for profile features:
 *   - Custom systemPrompt per profile
 *   - Thinking level per profile
 *   - Profile resolution from config
 *   - Default profile fallback
 */

import { createGateway, createControllableBrain, text, thinking } from "pi-mock";
import { Council } from "../dist/src/core/council.js";
import { getDefaultConfig, resolveProfile, resolveModelIds, loadConfig, saveConfig, getConfigPath } from "../dist/src/core/config.js";
import { COUNCIL_SYSTEM_PROMPT } from "../dist/src/core/profiles.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`  ❌ ${name}: ${err.message}\n`);
  }
}

// Isolate HOME
const testHome = mkdtempSync(join(tmpdir(), "pi-council-profile-test-"));
process.env.HOME = testHome;

// pi-mock gateway
const gw = await createGateway({ brain: () => text("unused"), port: 0, default: "allow" });

// Agent dir for pi-mock
const agentDir = mkdtempSync(join(tmpdir(), "pi-council-agentdir-"));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({
  providers: {
    "pi-mock": {
      baseUrl: `${gw.url}/v1`,
      api: "anthropic-messages",
      apiKey: "k",
      models: [{ id: "mock" }],
    },
  },
}));
writeFileSync(join(agentDir, "settings.json"), "{}");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";

process.stdout.write("\n🧪 Profile Tests\n\n");

// ─── Config Resolution Tests ─────────────────────────────────────────

process.stdout.write("── Config Resolution ──\n");

await test("P1: resolveProfile uses default profile when none specified", async () => {
  const config = getDefaultConfig();
  const resolved = resolveProfile(config);
  assert(resolved.name === "default", `name: ${resolved.name}`);
  assert(resolved.models.length === 4, "4 models");
  assert(resolved.systemPrompt === COUNCIL_SYSTEM_PROMPT, "has council system prompt");
});

await test("P2: resolveProfile picks named profile", async () => {
  const config = getDefaultConfig();
  config.profiles.quick = { models: ["claude", "gpt"] };
  const resolved = resolveProfile(config, "quick");
  assert(resolved.name === "quick", "name");
  assert(resolved.models.length === 2, "2 models");
  assert(resolved.models[0].id === "claude", "claude");
  assert(resolved.models[1].id === "gpt", "gpt");
});

await test("P3: Profile systemPrompt overrides config systemPrompt", async () => {
  const config = getDefaultConfig();
  config.profiles["code-review"] = {
    models: ["claude"],
    systemPrompt: "You are a code reviewer.",
  };
  const resolved = resolveProfile(config, "code-review");
  assert(resolved.systemPrompt === "You are a code reviewer.", "profile prompt");
});

await test("P4: Profile without systemPrompt inherits config systemPrompt", async () => {
  const config = getDefaultConfig();
  config.profiles.quick = { models: ["claude", "gpt"] };
  const resolved = resolveProfile(config, "quick");
  assert(resolved.systemPrompt === config.systemPrompt, "inherits config prompt");
});

await test("P5: Profile thinking level is preserved", async () => {
  const config = getDefaultConfig();
  config.profiles.deep = { models: ["claude"], thinking: "high" };
  const resolved = resolveProfile(config, "deep");
  assert(resolved.thinking === "high", "thinking");
});

await test("P6: Profile memberTimeoutMs is preserved", async () => {
  const config = getDefaultConfig();
  config.profiles.fast = { models: ["claude"], memberTimeoutMs: 30000 };
  const resolved = resolveProfile(config, "fast");
  assert(resolved.memberTimeoutMs === 30000, "timeout");
});

await test("P7: resolveModelIds picks from all models", async () => {
  const config = getDefaultConfig();
  const resolved = resolveModelIds(config, ["grok", "claude"]);
  assert(resolved.length === 2, "2 models");
  assert(resolved[0].id === "grok", "grok first");
  assert(resolved[1].id === "claude", "claude second");
});

await test("P8: resolveModelIds is case-insensitive", async () => {
  const config = getDefaultConfig();
  const resolved = resolveModelIds(config, ["CLAUDE", "Gpt"]);
  assert(resolved.length === 2, "2 models");
});

await test("P9: resolveProfile with unknown models skips them", async () => {
  const config = getDefaultConfig();
  config.profiles.partial = { models: ["claude", "nonexistent"] };
  const resolved = resolveProfile(config, "partial");
  assert(resolved.models.length === 1, "1 valid model");
  assert(resolved.models[0].id === "claude", "claude only");
});

await test("P10: resolveProfile throws if all models unknown", async () => {
  const config = getDefaultConfig();
  config.profiles.broken = { models: ["fake1", "fake2"] };
  let threw = false;
  try { resolveProfile(config, "broken"); } catch { threw = true; }
  assert(threw, "threw");
});

await test("P11: Config from disk with profiles loads correctly", async () => {
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    models: {
      test: { provider: "pi-mock", model: "mock" },
    },
    profiles: {
      myprofile: { models: ["test"], thinking: "low" },
    },
    defaultProfile: "myprofile",
    systemPrompt: "Custom base prompt.",
  }, null, 2));

  const config = loadConfig();
  assert(config.defaultProfile === "myprofile", "default");
  assert(config.systemPrompt === "Custom base prompt.", "prompt");
  const resolved = resolveProfile(config);
  assert(resolved.thinking === "low", "thinking from disk");
  assert(resolved.models[0].provider === "pi-mock", "provider from disk");
});

// ─── pi-mock Integration Tests ───────────────────────────────────────

process.stdout.write("\n── pi-mock Integration ──\n");

await test("P12: Council spawns with custom systemPrompt from profile", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Profile prompt test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
    systemPrompt: "You are a pirate captain.",
  });

  const call = await cb.waitForCall(5000);
  // Verify system prompt was passed
  assert(call.request.system !== undefined, "has system");
  const sys = Array.isArray(call.request.system)
    ? call.request.system.map(b => b.text).join(" ")
    : String(call.request.system);
  assert(sys.includes("pirate"), `system includes pirate: ${sys.slice(0, 200)}`);
  call.respond(text("Arr matey!"));

  await council.waitForCompletion();
  assert(council.isComplete(), "complete");
});

await test("P13: Council spawns with thinking level", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Thinking level test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
    thinking: "high",
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Deep thoughts."));
  await council.waitForCompletion();
  assert(council.isComplete(), "complete");
});

await test("P14: Two profiles produce different system prompts", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  // Profile A
  const c1 = new Council("Profile A");
  c1.spawn({
    models: [{ id: "a", provider: "pi-mock", model: "mock" }],
    systemPrompt: "You are a scientist.",
  });
  const call1 = await cb.waitForCall(5000);
  const sys1 = Array.isArray(call1.request.system)
    ? call1.request.system.map(b => b.text).join(" ")
    : String(call1.request.system);
  call1.respond(text("Science!"));
  await c1.waitForCompletion();

  // Profile B
  const c2 = new Council("Profile B");
  c2.spawn({
    models: [{ id: "b", provider: "pi-mock", model: "mock" }],
    systemPrompt: "You are a poet.",
  });
  const call2 = await cb.waitForCall(5000);
  const sys2 = Array.isArray(call2.request.system)
    ? call2.request.system.map(b => b.text).join(" ")
    : String(call2.request.system);
  call2.respond(text("Poetry!"));
  await c2.waitForCompletion();

  assert(sys1 !== sys2, "different system prompts");
  assert(sys1.includes("scientist"), "A has scientist");
  assert(sys2.includes("poet"), "B has poet");
});

await test("P15: Default council prompt used when no custom prompt", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Default prompt test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  const sys = Array.isArray(call.request.system)
    ? call.request.system.map(b => b.text).join(" ")
    : String(call.request.system);
  assert(sys.includes("council"), `default prompt includes council: ${sys.slice(0, 200)}`);
  call.respond(text("Council member here."));
  await council.waitForCompletion();
});

await test("P16: Member timeout cancels slow member", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Timeout test");
  council.spawn({
    models: [
      { id: "fast", provider: "pi-mock", model: "fast-m" },
      { id: "slow", provider: "pi-mock", model: "slow-m" },
    ],
    memberTimeoutMs: 500,
  });

  const fastCall = await cb.waitForCall({ model: "fast-m" }, 5000);
  fastCall.respond(text("Quick!"));
  // Don't respond to slow — let it timeout

  const result = await council.waitForCompletion();
  const fast = result.members.find(m => m.id === "fast");
  const slow = result.members.find(m => m.id === "slow");
  assert(fast.state === "done", "fast done");
  assert(slow.state === "cancelled", `slow cancelled: ${slow.state}`);
});

// ─── Done ────────────────────────────────────────────────────────────

await gw.close();

process.stdout.write(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed}\n`);
process.stdout.write(`\nMETRIC tests_passed=${passed}\n`);
process.stdout.write(`METRIC tests_failed=${failed}\n`);
process.exitCode = failed > 0 ? 1 : 0;
