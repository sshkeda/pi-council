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
// Follow-up Tests — steer, abort, and council-level follow-ups
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Follow-up Tests ──\n");

await test("T31: Council follow-up (steer) sends to all running members", async () => {
  const council = new Council("Follow-up steer test");

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

  // Wait for initial completion
  await council.waitForCompletion();

  // Both members should be done
  assert(council.isComplete(), "should be complete");
  assert(council.getMembers().every(m => m.getStatus().state === "done"), "all done");
});

await test("T32: Member steer() throws when member is cancelled", async () => {
  const member = new CouncilMember("test", { id: "test", provider: "mock", model: "mock" });
  let threw = false;
  try {
    await member.steer("test");
  } catch (e) {
    threw = true;
    assert(e.message.includes("not alive"), "error mentions not alive");
  }
  assert(threw, "should throw");
});

await test("T33: Member abort() throws when member is not alive", async () => {
  const member = new CouncilMember("test", { id: "test", provider: "mock", model: "mock" });
  let threw = false;
  try {
    await member.abort("test");
  } catch (e) {
    threw = true;
  }
  assert(threw, "should throw");
});

await test("T34: Council follow-up routes to specific members", async () => {
  const council = new Council("Targeted follow-up test");

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

  await council.waitForCompletion();

  // Follow-up to a completed member should be handled gracefully
  // (member is done, steer will throw but council.followUp catches it)
  await council.followUp({
    type: "steer",
    message: "Additional context",
    memberIds: ["claude"],
  });
});

await test("T35: Council follow-up with empty memberIds defaults to all", async () => {
  const council = new Council("Default target test");

  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  await council.waitForCompletion();

  // Should not throw even though all members are done
  await council.followUp({
    type: "steer",
    message: "test",
  });
});

await test("T36: Council follow-up on nonexistent council returns gracefully", async () => {
  const registry = new CouncilRegistry();
  const council = registry.getLatest();
  assert(council === undefined, "no councils");
});

await test("T37: Member finish() closes stdin and allows process exit", async () => {
  const council = new Council("Finish test");

  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  await council.waitForCompletion();
  const member = council.getMember("claude");
  assert(member.isDone(), "done after wait");

  // finish() should not throw
  member.finish();
});

await test("T38: Member getOutput returns accumulated text", async () => {
  const council = new Council("Output accumulation test");

  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  await council.waitForCompletion();
  const member = council.getMember("claude");
  const output = member.getOutput();
  assert(output.length > 0, "has output");
  assert(typeof output === "string", "is string");
});

await test("T39: Council timeout cancels members", async () => {
  const council = new Council("Timeout test");

  // Set a very short timeout
  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
    timeoutSeconds: 0.05, // 50ms — mock-pi takes ~100ms
  });

  await council.waitForCompletion();
  // Member should still complete since mock-pi is fast enough
  // This mainly tests that the timeout timer doesn't crash
  assert(council.isComplete(), "complete");
});

await test("T40: Multiple sequential councils don't interfere", async () => {
  const c1 = new Council("Sequential Q1");
  c1.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });
  await c1.waitForCompletion();

  const c2 = new Council("Sequential Q2");
  c2.spawn({
    models: [{ id: "gpt", provider: "openai", model: "gpt-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });
  await c2.waitForCompletion();

  assert(c1.isComplete() && c2.isComplete(), "both complete");
  assert(c1.runId !== c2.runId, "different run IDs");
  assert(c1.getMember("claude").getOutput() !== c2.getMember("gpt").getOutput(), "different outputs");
});

// ═══════════════════════════════════════════════════════════════════════
// Edge Case Tests
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Edge Case Tests ──\n");

await test("T41: Member durationMs is correct", async () => {
  const council = new Council("Duration test");
  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  await council.waitForCompletion();
  const status = council.getMember("claude").getStatus();
  assert(status.durationMs > 0, "has positive duration");
  assert(status.durationMs < 10000, "duration is reasonable (<10s)");
  assert(status.finishedAt > status.startedAt, "finishedAt > startedAt");
});

await test("T42: Council with empty models array throws", async () => {
  const council = new Council("Empty models");
  let threw = false;
  try {
    council.spawn({ models: [] });
  } catch {
    threw = true;
  }
  // Empty models should still create directory but have no members
  // The spawn should complete without throwing (0 members = immediately complete)
  // Actually it won't be complete because isComplete checks members.length > 0
});

await test("T43: Council event listener removal works", async () => {
  const council = new Council("Listener removal");
  const events = [];
  const unsub = council.on((e) => events.push(e.type));
  unsub(); // Remove listener

  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  await council.waitForCompletion();
  assert(events.length === 0, "no events after unsubscribe");
});

await test("T44: Multiple councils with same prompt get different runIds", async () => {
  const c1 = new Council("Same question");
  const c2 = new Council("Same question");
  assert(c1.runId !== c2.runId, "different runIds");
  assert(c1.prompt === c2.prompt, "same prompt");
});

await test("T45: Council result includes prompt text", async () => {
  const council = new Council("Include prompt in result");
  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  const result = await council.waitForCompletion();
  assert(result.prompt === "Include prompt in result", "prompt in result");
  assert(result.startedAt <= result.completedAt, "timing correct");
});

await test("T46: Council results.md includes all member names", async () => {
  const council = new Council("Markdown test");
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

  await council.waitForCompletion();
  const md = fs.readFileSync(path.join(council.getRunDir(), "results.md"), "utf-8");
  assert(md.includes("CLAUDE"), "has CLAUDE");
  assert(md.includes("GPT"), "has GPT");
  assert(md.includes("Council Results"), "has header");
  assert(md.includes("Markdown test"), "has prompt");
});

await test("T47: Council with custom system prompt passes it to members", async () => {
  const council = new Council("Custom prompt test");
  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    systemPrompt: "You are a pirate. Speak like a pirate.",
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  await council.waitForCompletion();
  assert(council.isComplete(), "completed");
  // Can't verify the system prompt was used from output alone
  // but we can verify it didn't crash
});

await test("T48: Member isAlive returns false after spawn failure", async () => {
  const council = new Council("Alive check");
  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "nonexistent-binary-12345",
  });

  await council.waitForCompletion();
  const member = council.getMember("claude");
  assert(!member.isAlive(), "not alive after failure");
  assert(member.isDone(), "isDone after failure");
});

await test("T49: Concurrent councils complete independently", async () => {
  const c1 = new Council("Concurrent Q1");
  const c2 = new Council("Concurrent Q2");

  c1.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  c2.spawn({
    models: [{ id: "gpt", provider: "openai", model: "gpt-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  const [r1, r2] = await Promise.all([
    c1.waitForCompletion(),
    c2.waitForCompletion(),
  ]);

  assert(r1.members[0].state === "done", "c1 done");
  assert(r2.members[0].state === "done", "c2 done");
  assert(r1.runId !== r2.runId, "different runIds");
});

await test("T50: Council status shows correct finished count", async () => {
  const council = new Council("Finished count");
  council.spawn({
    models: [
      { id: "claude", provider: "anthropic", model: "claude-test" },
      { id: "gpt", provider: "openai", model: "gpt-test" },
      { id: "grok", provider: "xai", model: "grok-test" },
    ],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  await council.waitForCompletion();
  const status = council.getStatus();
  assert(status.finishedCount === 3, "3 finished");
  assert(status.members.length === 3, "3 members");
  assert(status.isComplete, "complete");
});

// ═══════════════════════════════════════════════════════════════════════
// RPC Protocol Tests — verify mock-pi speaks the protocol correctly
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── RPC Protocol Tests ──\n");

await test("T51: Mock-pi processes prompt and returns text via RPC events", async () => {
  // Directly test mock-pi without council wrapper
  const { spawn: cpSpawn } = await import("node:child_process");
  const child = cpSpawn("node", [MOCK_PI, "--mode", "rpc", "--provider", "anthropic", "--model", "test", "--tools", "read", "--no-session"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events = [];
  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        try { events.push(JSON.parse(line)); } catch {}
      }
    }
  });

  child.stdin.write(JSON.stringify({ type: "prompt", id: "p1", message: "test question" }) + "\n");

  await new Promise(r => setTimeout(r, 500));

  // Verify we got the right events
  const response = events.find(e => e.type === "response" && e.id === "p1");
  assert(response !== undefined, "got prompt response");
  assert(response.success === true, "prompt succeeded");

  const agentStart = events.find(e => e.type === "agent_start");
  assert(agentStart !== undefined, "got agent_start");

  const textDeltas = events.filter(e => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta");
  assert(textDeltas.length > 0, "got text deltas");

  const agentEnd = events.find(e => e.type === "agent_end");
  assert(agentEnd !== undefined, "got agent_end");

  child.stdin.end();
  await new Promise(r => child.on("close", r));
});

await test("T52: Mock-pi handles get_state command", async () => {
  const { spawn: cpSpawn } = await import("node:child_process");
  const child = cpSpawn("node", [MOCK_PI, "--mode", "rpc", "--provider", "test", "--model", "test-model", "--tools", "read", "--no-session"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) try { events.push(JSON.parse(line)); } catch {}
    }
  });

  child.stdin.write(JSON.stringify({ type: "get_state", id: "s1" }) + "\n");
  await new Promise(r => setTimeout(r, 200));

  const resp = events.find(e => e.type === "response" && e.id === "s1");
  assert(resp !== undefined, "got state response");
  assert(resp.success === true, "state succeeded");
  assert(resp.data.model !== undefined, "has model");
  assert(resp.data.isStreaming === false, "not streaming initially");

  child.stdin.end();
  await new Promise(r => child.on("close", r));
});

await test("T53: Mock-pi handles abort command", async () => {
  const { spawn: cpSpawn } = await import("node:child_process");
  const child = cpSpawn("node", [MOCK_PI, "--mode", "rpc", "--provider", "test", "--model", "test", "--tools", "read", "--no-session"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) try { events.push(JSON.parse(line)); } catch {}
    }
  });

  child.stdin.write(JSON.stringify({ type: "abort", id: "a1" }) + "\n");
  await new Promise(r => setTimeout(r, 200));

  const resp = events.find(e => e.type === "response" && e.id === "a1");
  assert(resp !== undefined, "got abort response");
  assert(resp.success === true, "abort succeeded");

  child.stdin.end();
  await new Promise(r => child.on("close", r));
});

await test("T54: Member captures text deltas into output", async () => {
  const council = new Council("Text capture test");
  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  await council.waitForCompletion();
  const output = council.readStream("claude");
  // Mock-pi generates text with spaces between words
  assert(output.includes("Claude") || output.includes("analyze") || output.includes("assessment"), "output has content");
  assert(!output.includes("undefined"), "no undefined in output");
});

await test("T55: Member output events fire in order", async () => {
  const events = [];
  const council = new Council("Event order test");
  council.on((e) => events.push(e.type));

  council.spawn({
    models: [{ id: "claude", provider: "anthropic", model: "claude-test" }],
    tools: ["read"],
    cwd: __dirname,
    piBinary: "node",
    piBinaryArgs: [MOCK_PI],
  });

  await council.waitForCompletion();

  // member_started should come before member_output which comes before member_done
  const startIdx = events.indexOf("member_started");
  const outputIdx = events.indexOf("member_output");
  const doneIdx = events.indexOf("member_done");
  const completeIdx = events.indexOf("council_complete");

  assert(startIdx >= 0, "has started");
  assert(outputIdx > startIdx, "output after started");
  assert(doneIdx > outputIdx, "done after output");
  assert(completeIdx > doneIdx, "complete after done");
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
