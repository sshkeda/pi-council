#!/usr/bin/env node

/**
 * Council test suite — deterministic tests using mock-pi.
 *
 * Tests the full council lifecycle: spawn, follow-ups, cancel, status, streams.
 * Zero API calls. Fully sandboxed.
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PI = path.join(__dirname, "mock-pi.mjs");

// Dynamically import the council core (after build)
const { Council, CouncilRegistry } = await import("../dist/src/core/council.js");
const { CouncilMember } = await import("../dist/src/core/member.js");
const { getProfile, resolveModels, DEFAULT_MODELS, PROFILES } = await import("../dist/src/core/profiles.js");
const { generateRunId } = await import("../dist/src/util/run-id.js");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
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

// Override HOME for isolation
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-test-"));
process.env.HOME = testHome;

process.stdout.write("\n🧪 Council Test Suite\n\n");

// ═══════════════════════════════════════════════════════════════════════
// Unit Tests — no process spawning
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("── Unit Tests ──\n");

await test("T1: Council stores prompt and generates runId", async () => {
  const council = new Council("What is 2+2?");
  assert(council.prompt === "What is 2+2?", "prompt");
  assert(council.runId.length > 0, "runId");
  assert(typeof council.startedAt === "number", "startedAt");
});

await test("T2: CouncilRegistry tracks and retrieves councils", async () => {
  const registry = new CouncilRegistry();
  const c1 = new Council("Q1");
  const c2 = new Council("Q2");
  registry.add(c1);
  registry.add(c2);
  assert(registry.get(c1.runId) === c1, "get c1");
  assert(registry.get(c2.runId) === c2, "get c2");
  assert(registry.getLatest() === c2, "latest is c2");
  assert(registry.list().length === 2, "list length");
  registry.remove(c1.runId);
  assert(registry.get(c1.runId) === undefined, "c1 removed");
  assert(registry.list().length === 1, "list after remove");
});

await test("T3: Profile resolution — max has 4 models with bash", async () => {
  const max = getProfile("max");
  assert(max !== undefined, "exists");
  assert(max.models.length === 4, "4 models");
  assert(max.tools.includes("bash"), "has bash");
  assert(max.tools.includes("read"), "has read");
});

await test("T4: Profile resolution — fast has 2 models", async () => {
  const fast = getProfile("fast");
  assert(fast !== undefined, "exists");
  assert(fast.models.length === 2, "2 models");
});

await test("T5: Profile resolution — read-only excludes bash", async () => {
  const ro = getProfile("read-only");
  assert(ro !== undefined, "exists");
  assert(!ro.tools.includes("bash"), "no bash");
  assert(ro.tools.includes("read"), "has read");
});

await test("T6: Unknown profile returns undefined", async () => {
  assert(getProfile("nonexistent") === undefined, "undefined");
});

await test("T7: resolveModels filters correctly", async () => {
  const filtered = resolveModels(DEFAULT_MODELS, ["claude", "grok"]);
  assert(filtered.length === 2, "2 models");
  assert(filtered[0].id === "claude", "claude first");
  assert(filtered[1].id === "grok", "grok second");
});

await test("T8: resolveModels with no filter returns all", async () => {
  const all = resolveModels(DEFAULT_MODELS);
  assert(all.length === 4, "all 4");
});

await test("T9: Run IDs are unique", async () => {
  const id1 = generateRunId();
  const id2 = generateRunId();
  assert(id1 !== id2, "unique");
  assert(/^\d{8}-/.test(id1), "date format");
});

await test("T10: CouncilMember initial state is spawning", async () => {
  const member = new CouncilMember("claude", { id: "claude", provider: "anthropic", model: "test" });
  const status = member.getStatus();
  assert(status.id === "claude", "id");
  assert(status.state === "spawning", "state");
  assert(status.output === "", "empty output");
  assert(!status.isStreaming, "not streaming");
});

await test("T11: CouncilMember on() returns unsubscribe function", async () => {
  const member = new CouncilMember("test", { id: "test", provider: "mock", model: "mock" });
  const unsub = member.on(() => {});
  assert(typeof unsub === "function", "returns function");
  unsub(); // should not throw
});

await test("T12: Council.getStatus() structure is correct", async () => {
  const council = new Council("Status test");
  const status = council.getStatus();
  assert(typeof status.runId === "string", "runId");
  assert(typeof status.prompt === "string", "prompt");
  assert(Array.isArray(status.members), "members array");
  assert(status.finishedCount === 0, "0 finished");
  assert(!status.isComplete, "not complete");
});

await test("T13: Council.getResult() structure is correct", async () => {
  const council = new Council("Result test");
  const result = council.getResult();
  assert(typeof result.runId === "string", "runId");
  assert(typeof result.completedAt === "number", "completedAt");
  assert(Array.isArray(result.members), "members array");
});

await test("T14: Unknown profile in spawn() throws", async () => {
  const council = new Council("Bad profile");
  let threw = false;
  try { council.spawn({ profile: "nonexistent" }); } catch { threw = true; }
  assert(threw, "threw");
});

await test("T15: Cancel on empty council doesn't throw", async () => {
  const council = new Council("Cancel test");
  council.cancel(); // should not throw
  council.cancel(["nonexistent"]); // should not throw
});

await test("T16: readStream throws for unknown member", async () => {
  const council = new Council("Stream test");
  let threw = false;
  try { council.readStream("nonexistent"); } catch (e) { threw = true; assert(e.message.includes("Unknown"), "msg"); }
  assert(threw, "threw");
});

await test("T17: All profiles have council system prompts", async () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    assert(profile.systemPrompt.includes("council"), `${name} mentions council`);
    assert(profile.systemPrompt.includes("independent"), `${name} mentions independence`);
  }
});

await test("T18: Registry active() filters correctly", async () => {
  const registry = new CouncilRegistry();
  registry.add(new Council("Q1"));
  registry.add(new Council("Q2"));
  assert(registry.active().length === 2, "both active (no members = not complete)");
});

await test("T19: Council creates run directory and metadata", async () => {
  const council = new Council("Metadata test");
  try { council.spawn({ models: [{ id: "x", provider: "x", model: "x" }] }); } catch {}
  assert(fs.existsSync(council.getRunDir()), "dir exists");
  assert(fs.existsSync(path.join(council.getRunDir(), "meta.json")), "meta.json");
  assert(fs.existsSync(path.join(council.getRunDir(), "prompt.txt")), "prompt.txt");
  const meta = JSON.parse(fs.readFileSync(path.join(council.getRunDir(), "meta.json"), "utf-8"));
  assert(meta.prompt === "Metadata test", "prompt in meta");
});

await test("T20: Council getMember returns correct member", async () => {
  const council = new Council("getMember test");
  assert(council.getMember("nonexistent") === undefined, "undefined for unknown");
  assert(council.getMembers().length === 0, "empty before spawn");
});

// ═══════════════════════════════════════════════════════════════════════
// Integration Tests — spawn mock-pi processes
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Integration Tests (mock-pi) ──\n");

await test("T21: Council spawns mock-pi members and completes", async () => {
  const council = new Council("What is the meaning of life?");

  council.spawn({
    models: [
      { id: "claude", provider: "anthropic", model: "claude-test" },
      { id: "gpt", provider: "openai", model: "gpt-test" },
    ],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  assert(council.getMembers().length === 2, "2 members spawned");

  const result = await council.waitForCompletion();
  assert(result.members.length === 2, "2 results");
  assert(result.members.every(m => m.state === "done"), "all done");
  assert(result.members.every(m => m.output.length > 0), "all have output");
});

await test("T22: Council tracks member status during run", async () => {
  const council = new Council("Status tracking test");

  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  // Check status immediately
  const status = council.getStatus();
  assert(status.members.length === 1, "1 member");
  assert(status.prompt === "Status tracking test", "prompt");

  await council.waitForCompletion();
  const finalStatus = council.getStatus();
  assert(finalStatus.isComplete, "complete");
  assert(finalStatus.finishedCount === 1, "1 finished");
  assert(finalStatus.members[0].state === "done", "member done");
});

await test("T23: Council readStream returns member output", async () => {
  const council = new Council("Stream read test");

  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  await council.waitForCompletion();
  const stream = council.readStream("claude");
  assert(stream.length > 0, "has output");
});

await test("T24: Council cancel kills running members", async () => {
  const council = new Council("Cancel test");

  // Use a longer delay so we can cancel
  const env = { ...process.env, MOCK_PI_DELAY_MS: "2000" };

  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  // Cancel immediately
  council.cancel();
  const member = council.getMember("claude");
  // Give a moment for process cleanup
  await new Promise(r => setTimeout(r, 100));
  assert(member.isDone(), "member is done after cancel");
  assert(member.getStatus().state === "cancelled", "state is cancelled");
});

await test("T25: Council cancel specific member", async () => {
  const council = new Council("Cancel specific test");

  council.spawn({
    models: [
      { id: "claude", provider: "anthropic", model: "claude-test" },
      { id: "gpt", provider: "openai", model: "gpt-test" },
    ],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  // Cancel only claude
  council.cancel(["claude"]);
  await new Promise(r => setTimeout(r, 100));

  const claude = council.getMember("claude");
  assert(claude.getStatus().state === "cancelled", "claude cancelled");

  // GPT should still be running or done
  const gpt = council.getMember("gpt");
  assert(gpt.getStatus().state !== "cancelled", "gpt not cancelled");

  // Wait for gpt to finish
  await gpt.waitForDone();
  assert(gpt.getStatus().state === "done", "gpt done");
});

await test("T26: Council emits events during lifecycle", async () => {
  const events = [];
  const council = new Council("Event test");

  council.on((event) => events.push(event.type));

  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  await council.waitForCompletion();

  assert(events.includes("member_started"), "has member_started");
  assert(events.includes("member_output"), "has member_output");
  assert(events.includes("member_done"), "has member_done");
  assert(events.includes("council_complete"), "has council_complete");
});

await test("T27: Council writes result artifacts on completion", async () => {
  const council = new Council("Artifact test");

  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  await council.waitForCompletion();

  const resultsJson = path.join(council.getRunDir(), "results.json");
  const resultsMd = path.join(council.getRunDir(), "results.md");

  assert(fs.existsSync(resultsJson), "results.json exists");
  assert(fs.existsSync(resultsMd), "results.md exists");

  const parsed = JSON.parse(fs.readFileSync(resultsJson, "utf-8"));
  assert(parsed.runId === council.runId, "runId in results.json");
  assert(parsed.members.length === 1, "1 member in results");
  assert(parsed.members[0].state === "done", "member state in results");

  const md = fs.readFileSync(resultsMd, "utf-8");
  assert(md.includes("Council Results"), "results.md has header");
  assert(md.includes("CLAUDE"), "results.md has model name");
});

await test("T28: Council handles mock-pi failure", async () => {
  const council = new Council("Failure test");

  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  // Override env for the child — but we can't easily do that after spawn
  // Instead, test with a nonexistent binary
  const council2 = new Council("Failure test 2");
  council2.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "nonexistent-binary-that-does-not-exist",
  });

  await council2.waitForCompletion();
  const status = council2.getStatus();
  assert(status.isComplete, "complete after failure");
  assert(status.members[0].state === "failed", "member failed");
  assert(status.members[0].error !== undefined, "has error message");

  // Clean up the first council
  await council.waitForCompletion();
});

await test("T29: Member waitForDone resolves immediately if already done", async () => {
  const council = new Council("Already done test");

  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  await council.waitForCompletion();

  // waitForDone on an already-done member should resolve immediately
  const member = council.getMember("claude");
  const status = await member.waitForDone();
  assert(status.state === "done", "already done");
});

await test("T30: Four model council completes", async () => {
  const council = new Council("Full council test");

  council.spawn({
    models: [
      { id: "claude", provider: "anthropic", model: "claude-test" },
      { id: "gpt", provider: "openai", model: "gpt-test" },
      { id: "gemini", provider: "google", model: "gemini-test" },
      { id: "grok", provider: "xai", model: "grok-test" },
    ],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  const result = await council.waitForCompletion();
  assert(result.members.length === 4, "4 members");
  assert(result.members.every(m => m.state === "done"), "all done");
  assert(result.members.every(m => m.output.length > 0), "all have output");
  assert(result.members.every(m => m.durationMs > 0), "all have duration");
});

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed}\n\n`);

process.stdout.write(`METRIC tests_passed=${passed}\n`);
process.stdout.write(`METRIC tests_failed=${failed}\n`);
process.stdout.write(`METRIC tests_total=${passed + failed}\n`);

// Cleanup
fs.rmSync(testHome, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
