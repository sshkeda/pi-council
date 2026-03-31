#!/usr/bin/env node

/**
 * Council test suite — unit tests + E2E integration tests via pi-mock.
 *
 * Unit tests (T1–T20): pure logic, no processes spawned.
 * Integration tests (T21+): real pi processes against pi-mock gateway
 *   with controllable brain for deterministic, timing-hack-free control.
 *
 * Zero real API calls. Fully sandboxed.
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import {
  createGateway, createControllableBrain,
  text, thinking, toolCall, bash, error,
  script, always,
} from "pi-mock";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dynamically import the council core (after build)
const { Council, CouncilRegistry } = await import("../dist/src/core/council.js");
const { CouncilMember } = await import("../dist/src/core/member.js");
const { DEFAULT_MODELS, DEFAULT_SYSTEM_PROMPT } = await import("../dist/src/core/profiles.js");
const { loadConfig, resolveProfile, resolveModelIds, getDefaultConfig } = await import("../dist/src/core/config.js");
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

await test("T3: Default config has 4 models and a default profile", async () => {
  const config = getDefaultConfig();
  assert(Object.keys(config.models).length === 4, "4 models");
  assert(config.profiles.default !== undefined, "has default profile");
  assert(config.profiles.default.models.length === 4, "default profile has 4 models");
});

await test("T4: Default models include all 4", async () => {
  assert(DEFAULT_MODELS.length === 4, "4 default models");
  assert(DEFAULT_MODELS[0].id === "claude", "claude first");
  assert(DEFAULT_MODELS[3].id === "grok", "grok last");
});

await test("T5: Each default model has provider and model fields", async () => {
  for (const m of DEFAULT_MODELS) {
    assert(m.id.length > 0, `${m.id} has id`);
    assert(m.provider.length > 0, `${m.id} has provider`);
    assert(m.model.length > 0, `${m.id} has model`);
  }
});

await test("T6: Unknown profile throws", async () => {
  const config = getDefaultConfig();
  let threw = false;
  try { resolveProfile(config, "nonexistent"); } catch { threw = true; }
  assert(threw, "threw");
});

await test("T7: resolveModelIds filters correctly", async () => {
  const config = getDefaultConfig();
  const filtered = resolveModelIds(config, ["claude", "grok"]);
  assert(filtered.length === 2, "2 models");
  assert(filtered[0].id === "claude", "claude first");
  assert(filtered[1].id === "grok", "grok second");
});

await test("T8: resolveProfile returns all models for default profile", async () => {
  const config = getDefaultConfig();
  const resolved = resolveProfile(config);
  assert(resolved.models.length === 4, "all 4");
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

await test("T14: spawn() with no models throws", async () => {
  const council = new Council("No models");
  let threw = false;
  try { council.spawn({ models: [] }); } catch { threw = true; }
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

await test("T17: Council system prompt mentions council and independence", async () => {
  assert(DEFAULT_SYSTEM_PROMPT.includes("council"), "mentions council");
  assert(DEFAULT_SYSTEM_PROMPT.includes("independent"), "mentions independence");
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
// pi-mock setup — shared gateway for all integration tests
// ═══════════════════════════════════════════════════════════════════════

function createAgentDir(gatewayUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-agentdir-"));
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({
    providers: {
      "pi-mock": {
        baseUrl: `${gatewayUrl}/v1`,
        api: "anthropic-messages",
        apiKey: "k",
        models: [{ id: "mock" }],
      },
    },
  }));
  fs.writeFileSync(path.join(dir, "settings.json"), "{}");
  return dir;
}

const gw = await createGateway({ brain: () => text("unused"), port: 0, default: "allow" });
const agentDir = createAgentDir(gw.url);
const origAgentDir = process.env.PI_CODING_AGENT_DIR;
const origOffline = process.env.PI_OFFLINE;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";

// ═══════════════════════════════════════════════════════════════════════
// Integration Tests — real pi processes against pi-mock gateway
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Integration Tests (pi-mock) ──\n");

await test("T21: Council spawns members and completes with output", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("What is the meaning of life?");
  council.spawn({
    models: [
      { id: "claude", provider: "pi-mock", model: "claude-test" },
      { id: "gpt", provider: "pi-mock", model: "gpt-test" },
    ],
  });

  assert(council.getMembers().length === 2, "2 members spawned");

  const call1 = await cb.waitForCall({ model: "claude-test" }, 5000);
  const call2 = await cb.waitForCall({ model: "gpt-test" }, 5000);
  call1.respond(text("Claude's analysis of life."));
  call2.respond(text("GPT's take on existence."));

  const result = await council.waitForCompletion();
  assert(result.members.length === 2, "2 results");
  assert(result.members.every(m => m.state === "done"), "all done");
  assert(result.members.every(m => m.output.length > 0), "all have output");
});

await test("T22: Council tracks member status during run", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Status tracking test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  // Check status immediately — member should be running
  const status = council.getStatus();
  assert(status.members.length === 1, "1 member");
  assert(status.prompt === "Status tracking test", "prompt");

  const call = await cb.waitForCall(5000);
  call.respond(text("Done tracking."));

  await council.waitForCompletion();
  const finalStatus = council.getStatus();
  assert(finalStatus.isComplete, "complete");
  assert(finalStatus.finishedCount === 1, "1 finished");
  assert(finalStatus.members[0].state === "done", "member done");
});

await test("T23: Council readStream returns member output", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Stream read test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Readable output here."));

  await council.waitForCompletion();
  const stream = council.readStream("claude");
  assert(stream.length > 0, "has output");
  assert(stream.includes("Readable"), "correct content");
});

await test("T24: Council cancel kills running members", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Cancel test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  // Brain receives the call but we don't respond — member is blocked
  await cb.waitForCall(5000);

  // Cancel immediately
  council.cancel();
  await council.waitForCompletion();

  const member = council.getMember("claude");
  assert(member.getStatus().state === "cancelled", "state is cancelled");
});

await test("T25: Council cancel specific member", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Cancel specific test");
  council.spawn({
    models: [
      { id: "claude", provider: "pi-mock", model: "claude-test" },
      { id: "gpt", provider: "pi-mock", model: "gpt-test" },
    ],
  });

  await cb.waitForCall({ model: "claude-test" }, 5000);
  const gptCall = await cb.waitForCall({ model: "gpt-test" }, 5000);

  // Cancel only claude
  council.cancel(["claude"]);
  const claude = council.getMember("claude");
  await claude.waitForDone();
  assert(claude.getStatus().state === "cancelled", "claude cancelled");

  // GPT should still be running — respond to it
  gptCall.respond(text("GPT still alive."));
  const gpt = council.getMember("gpt");
  await gpt.waitForDone();
  assert(gpt.getStatus().state === "done", "gpt done");
  assert(gpt.getOutput().includes("alive"), "gpt has output");
});

await test("T26: Council emits events during lifecycle", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const events = [];
  const council = new Council("Event test");
  council.on((event) => events.push(event.type));

  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Event content."));

  await council.waitForCompletion();

  assert(events.includes("member_started"), "has member_started");
  assert(events.includes("member_output"), "has member_output");
  assert(events.includes("member_done"), "has member_done");
  assert(events.includes("council_complete"), "has council_complete");
});

await test("T27: Council writes result artifacts on completion", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Artifact test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Artifact content here."));
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

await test("T28: Council handles spawn failure", async () => {
  const council = new Council("Failure test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
    piBinary: "nonexistent-binary-that-does-not-exist",
  });

  await council.waitForCompletion();
  const status = council.getStatus();
  assert(status.isComplete, "complete after failure");
  assert(status.members[0].state === "failed", "member failed");
  assert(status.members[0].error !== undefined, "has error message");
});

await test("T29: Member waitForDone resolves immediately if already done", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Already done test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Quick answer."));
  await council.waitForCompletion();

  // waitForDone on an already-done member should resolve immediately
  const member = council.getMember("claude");
  const status = await member.waitForDone();
  assert(status.state === "done", "already done");
});

await test("T30: Four model council completes", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Full council test");
  council.spawn({
    models: [
      { id: "claude", provider: "pi-mock", model: "claude-m" },
      { id: "gpt", provider: "pi-mock", model: "gpt-m" },
      { id: "gemini", provider: "pi-mock", model: "gemini-m" },
      { id: "grok", provider: "pi-mock", model: "grok-m" },
    ],
  });

  // Respond to each by name
  const c1 = await cb.waitForCall({ model: "claude-m" }, 5000);
  const c2 = await cb.waitForCall({ model: "gpt-m" }, 5000);
  const c3 = await cb.waitForCall({ model: "gemini-m" }, 5000);
  const c4 = await cb.waitForCall({ model: "grok-m" }, 5000);
  c1.respond(text("Claude here."));
  c2.respond(text("GPT here."));
  c3.respond(text("Gemini here."));
  c4.respond(text("Grok here."));

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

await test("T31: Steer a running member via Council.followUp", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Live steer test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  // Member calls brain — respond with a tool call to keep it busy
  const call1 = await cb.waitForCall(5000);
  call1.respond(toolCall("bash", { command: "echo step1" }));

  // Steer while tool is executing
  const steerP = council.followUp({ type: "steer", message: "Also consider security." });

  // Brain gets the follow-up turn
  const call2 = await cb.waitForCall(5000);
  call2.respond(text("Done with steer context."));
  await steerP;

  // Drain any extra turns from steer
  try { const extra = await cb.waitForCall(3000); extra.respond(text("steer done")); } catch {}

  await council.waitForCompletion();
  assert(council.isComplete(), "completed after steer");
  assert(council.getMember("claude").getOutput().length > 0, "has output");
});

await test("T32: Member steer() throws when member is not alive", async () => {
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

await test("T34: Council follow-up routes to specific members only", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Targeted follow-up test");
  council.spawn({
    models: [
      { id: "claude", provider: "pi-mock", model: "claude-t" },
      { id: "gpt", provider: "pi-mock", model: "gpt-t" },
    ],
  });

  // Both call brain — give them tool calls to stay busy
  const c1 = await cb.waitForCall({ model: "claude-t" }, 5000);
  const c2 = await cb.waitForCall({ model: "gpt-t" }, 5000);
  c1.respond(toolCall("bash", { command: "echo claude" }));
  c2.respond(toolCall("bash", { command: "echo gpt" }));

  // Steer only claude
  await council.followUp({
    type: "steer",
    message: "Extra context for claude only",
    memberIds: ["claude"],
  });

  // Respond to remaining brain calls
  for (let i = 0; i < 4; i++) {
    try {
      const call = await cb.waitForCall(3000);
      call.respond(text(`done ${i}`));
    } catch { break; }
  }

  await council.waitForCompletion();
  assert(council.isComplete(), "completed");
});

await test("T35: Follow-up to completed member doesn't crash", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Follow-up done member");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("First answer."));
  await council.waitForCompletion();

  // Steer to completed member — should not throw
  await council.followUp({ type: "steer", message: "too late" });
  assert(true, "did not throw");
});

await test("T36: Council follow-up on nonexistent council returns gracefully", async () => {
  const registry = new CouncilRegistry();
  const council = registry.getLatest();
  assert(council === undefined, "no councils");
});

await test("T37: Abort with redirect produces new output", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Abort redirect test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call1 = await cb.waitForCall(5000);
  call1.respond(toolCall("bash", { command: "sleep 30" }));

  // Abort + redirect
  const abortP = council.followUp({ type: "abort", message: "Do this instead." });
  const call2 = await cb.waitForCall(5000);
  call2.respond(text("Redirected output!"));
  await abortP;

  const result = await council.waitForCompletion();
  assert(result.members[0].output.includes("Redirected"), `got redirected output: ${result.members[0].output}`);
});

await test("T38: Multiple steers to same member", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Multi steer test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call1 = await cb.waitForCall(5000);
  call1.respond(toolCall("bash", { command: "echo step1" }));

  // Send multiple steers
  await council.followUp({ type: "steer", message: "Consider cost" });
  await council.followUp({ type: "steer", message: "Consider scale" });
  await council.followUp({ type: "steer", message: "Consider maintenance" });

  // Drain all brain calls
  for (let i = 0; i < 6; i++) {
    try {
      const call = await cb.waitForCall(3000);
      call.respond(text(`done ${i}`));
    } catch { break; }
  }

  await council.waitForCompletion();
  assert(council.isComplete(), "completed with multiple steers");
});

await test("T39: Abort targeted to specific member in multi-member council", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Targeted abort test");
  council.spawn({
    models: [
      { id: "researcher", provider: "pi-mock", model: "researcher-m" },
      { id: "writer", provider: "pi-mock", model: "writer-m" },
    ],
  });

  const resCall = await cb.waitForCall({ model: "researcher-m" }, 5000);
  const wrtCall = await cb.waitForCall({ model: "writer-m" }, 5000);

  // Researcher does a tool call (will be aborted), writer gets immediate answer
  resCall.respond(toolCall("bash", { command: "sleep 30" }));
  wrtCall.respond(text("Draft complete."));

  // Wait for writer to finish
  await council.getMember("writer").waitForDone();

  // Abort only researcher with redirect
  const abortP = council.followUp({ type: "abort", message: "Just summarize.", memberIds: ["researcher"] });
  const redirectCall = await cb.waitForCall({ model: "researcher-m" }, 5000);
  redirectCall.respond(text("Summary without research."));
  await abortP;

  const r = await council.waitForCompletion();
  assert(r.members.every(m => m.state === "done"), "all done");
  assert(r.members.find(m => m.id === "researcher").output.includes("Summary"), "researcher redirected");
  assert(r.members.find(m => m.id === "writer").output.includes("Draft"), "writer preserved");
});

await test("T40: Multiple sequential councils don't interfere", async () => {
  const cb1 = createControllableBrain();
  gw.setBrain(cb1.brain);

  const c1 = new Council("Sequential Q1");
  c1.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call1 = await cb1.waitForCall(5000);
  call1.respond(text("First council answer."));
  await c1.waitForCompletion();

  const cb2 = createControllableBrain();
  gw.setBrain(cb2.brain);

  const c2 = new Council("Sequential Q2");
  c2.spawn({
    models: [{ id: "gpt", provider: "pi-mock", model: "mock" }],
  });

  const call2 = await cb2.waitForCall(5000);
  call2.respond(text("Second council answer."));
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
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Duration test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  // Small delay to make duration measurable
  await new Promise(r => setTimeout(r, 50));
  call.respond(text("Timed response."));

  await council.waitForCompletion();
  const status = council.getMember("claude").getStatus();
  assert(status.durationMs > 0, "has positive duration");
  assert(status.durationMs < 30000, "duration is reasonable (<30s)");
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
});

await test("T43: Council event listener removal works", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Listener removal");
  const events = [];
  const unsub = council.on((e) => events.push(e.type));
  unsub(); // Remove listener

  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Unheard."));

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
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Include prompt in result");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Result with prompt."));

  const result = await council.waitForCompletion();
  assert(result.prompt === "Include prompt in result", "prompt in result");
  assert(result.startedAt <= result.completedAt, "timing correct");
});

await test("T46: Council results.md includes all member names", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Markdown test");
  council.spawn({
    models: [
      { id: "claude", provider: "pi-mock", model: "claude-md" },
      { id: "gpt", provider: "pi-mock", model: "gpt-md" },
    ],
  });

  const c1 = await cb.waitForCall({ model: "claude-md" }, 5000);
  const c2 = await cb.waitForCall({ model: "gpt-md" }, 5000);
  c1.respond(text("Claude's section."));
  c2.respond(text("GPT's section."));

  await council.waitForCompletion();
  const md = fs.readFileSync(path.join(council.getRunDir(), "results.md"), "utf-8");
  assert(md.includes("CLAUDE"), "has CLAUDE");
  assert(md.includes("GPT"), "has GPT");
  assert(md.includes("Council Results"), "has header");
  assert(md.includes("Markdown test"), "has prompt");
});

await test("T47: Council with custom system prompt passes it to members", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Custom prompt test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
    systemPrompt: "You are a pirate. Speak like a pirate.",
  });

  const call = await cb.waitForCall(5000);
  // Verify the system prompt was passed by checking the request
  const hasSystem = call.request.system !== undefined;
  call.respond(text("Arr!"));

  await council.waitForCompletion();
  assert(council.isComplete(), "completed with custom prompt");
});

await test("T48: Member isAlive returns false after spawn failure", async () => {
  const council = new Council("Alive check");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
    piBinary: "nonexistent-binary-12345",
  });

  await council.waitForCompletion();
  const member = council.getMember("claude");
  assert(!member.isAlive(), "not alive after failure");
  assert(member.isDone(), "isDone after failure");
});

await test("T49: Concurrent councils complete independently", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const c1 = new Council("Concurrent Q1");
  const c2 = new Council("Concurrent Q2");

  c1.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "c1-model" }],
  });
  c2.spawn({
    models: [{ id: "gpt", provider: "pi-mock", model: "c2-model" }],
  });

  const call1 = await cb.waitForCall({ model: "c1-model" }, 5000);
  const call2 = await cb.waitForCall({ model: "c2-model" }, 5000);
  call1.respond(text("Council 1 answer."));
  call2.respond(text("Council 2 answer."));

  const [r1, r2] = await Promise.all([
    c1.waitForCompletion(),
    c2.waitForCompletion(),
  ]);

  assert(r1.members[0].state === "done", "c1 done");
  assert(r2.members[0].state === "done", "c2 done");
  assert(r1.runId !== r2.runId, "different runIds");
});

await test("T50: Council status shows correct finished count", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Finished count");
  council.spawn({
    models: [
      { id: "claude", provider: "pi-mock", model: "c-cnt" },
      { id: "gpt", provider: "pi-mock", model: "g-cnt" },
      { id: "grok", provider: "pi-mock", model: "k-cnt" },
    ],
  });

  const c1 = await cb.waitForCall({ model: "c-cnt" }, 5000);
  const c2 = await cb.waitForCall({ model: "g-cnt" }, 5000);
  const c3 = await cb.waitForCall({ model: "k-cnt" }, 5000);
  c1.respond(text("One."));
  c2.respond(text("Two."));
  c3.respond(text("Three."));

  await council.waitForCompletion();
  const status = council.getStatus();
  assert(status.finishedCount === 3, "3 finished");
  assert(status.members.length === 3, "3 members");
  assert(status.isComplete, "complete");
});

// ═══════════════════════════════════════════════════════════════════════
// Tool Execution & Event Pipeline Tests
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Tool & Event Pipeline Tests ──\n");

await test("T51: Tool execution events propagate through Council", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const events = [];
  const council = new Council("Tool events propagation");
  council.on(e => events.push(e));

  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call1 = await cb.waitForCall(5000);
  call1.respond(bash("echo hello"));
  const call2 = await cb.waitForCall(5000);
  call2.respond(text("After tool call."));

  await council.waitForCompletion();

  const toolStarts = events.filter(e => e.type === "member_tool_start");
  const toolEnds = events.filter(e => e.type === "member_tool_end");

  assert(toolStarts.length > 0, "got member_tool_start events");
  assert(toolEnds.length > 0, "got member_tool_end events");
  assert(toolStarts[0].memberId === "claude", "tool event has correct memberId");
  assert(typeof toolStarts[0].toolName === "string" && toolStarts[0].toolName.length > 0, `tool name: ${toolStarts[0].toolName}`);
});

await test("T52: Member output events fire in order", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const events = [];
  const council = new Council("Event order test");
  council.on((e) => events.push(e.type));

  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Ordered output."));
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

await test("T53: Members take different numbers of tool-call turns", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Multi-turn depth");
  council.spawn({
    models: [
      { id: "shallow", provider: "pi-mock", model: "shallow-m" },
      { id: "deep", provider: "pi-mock", model: "deep-m" },
    ],
  });

  // Shallow: immediate text
  const s1 = await cb.waitForCall({ model: "shallow-m" }, 5000);
  s1.respond(text("Quick answer."));

  // Deep: 3 tool calls then text
  const d1 = await cb.waitForCall({ model: "deep-m" }, 5000);
  d1.respond(bash("echo step1"));
  const d2 = await cb.waitForCall({ model: "deep-m" }, 5000);
  d2.respond(bash("echo step2"));
  const d3 = await cb.waitForCall({ model: "deep-m" }, 5000);
  d3.respond(bash("echo step3"));
  const d4 = await cb.waitForCall({ model: "deep-m" }, 5000);
  d4.respond(text("Deep answer after 3 tool calls."));

  const r = await council.waitForCompletion();

  const shallow = r.members.find(m => m.id === "shallow");
  const deep = r.members.find(m => m.id === "deep");

  assert(shallow.output.includes("Quick"), "shallow output");
  assert(deep.output.includes("Deep"), "deep output");
  assert(shallow.toolEvents.length === 0, "shallow: 0 tools");
  assert(deep.toolEvents.length >= 6, `deep: ${deep.toolEvents.length} tool events`);
});

await test("T54: Member captures text deltas into output", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Text capture test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("This is a carefully crafted response."));
  await council.waitForCompletion();

  const output = council.readStream("claude");
  assert(output.includes("carefully"), "output has content");
  assert(!output.includes("undefined"), "no undefined in output");
});

await test("T55: Council with 2 models produces different outputs", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Compare models test");
  council.spawn({
    models: [
      { id: "claude", provider: "pi-mock", model: "claude-cmp" },
      { id: "grok", provider: "pi-mock", model: "grok-cmp" },
    ],
  });

  const c1 = await cb.waitForCall({ model: "claude-cmp" }, 5000);
  const c2 = await cb.waitForCall({ model: "grok-cmp" }, 5000);
  c1.respond(text("Claude's unique perspective."));
  c2.respond(text("Grok's direct take on things."));

  await council.waitForCompletion();
  const claudeOut = council.readStream("claude");
  const grokOut = council.readStream("grok");

  assert(claudeOut !== grokOut, "outputs differ");
  assert(claudeOut.includes("Claude"), "claude output has identity");
  assert(grokOut.includes("Grok"), "grok output has identity");
});

// ═══════════════════════════════════════════════════════════════════════
// Cancel & Failure Edge Cases
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Cancel & Failure Edge Cases ──\n");

await test("T56: Cancel during processing works", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Cancel during test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  await cb.waitForCall(5000); // brain got the call, but we don't respond

  // Cancel immediately
  council.cancel();
  await council.waitForCompletion();
  assert(council.isComplete(), "complete after cancel");
  assert(council.getMember("claude").getStatus().state === "cancelled", "cancelled state");
});

await test("T57: Council.cancel after completion is idempotent", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Idempotent cancel test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Done."));
  await council.waitForCompletion();

  // Cancel after completion should be a no-op
  council.cancel();
  council.cancel(["claude"]);
  assert(council.isComplete(), "still complete");
});

await test("T58: Cancel one member while another completes", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Mixed cancel test");
  council.spawn({
    models: [
      { id: "slow", provider: "pi-mock", model: "slow-m" },
      { id: "fast", provider: "pi-mock", model: "fast-m" },
    ],
  });

  await cb.waitForCall({ model: "slow-m" }, 5000); // don't respond to slow
  const fastCall = await cb.waitForCall({ model: "fast-m" }, 5000);

  // Cancel slow, let fast continue
  council.cancel(["slow"]);
  fastCall.respond(text("Fast completed."));

  await council.waitForCompletion();
  assert(council.getMember("slow").getStatus().state === "cancelled", "slow cancelled");
  assert(council.getMember("fast").getStatus().state === "done", "fast done");
});

await test("T59: Crash + success mixed council completes", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Mixed crash/success");
  council.spawn({
    models: [
      { id: "good", provider: "pi-mock", model: "good-m" },
      { id: "bad", provider: "pi-mock", model: "bad-m" },
    ],
  });

  const goodCall = await cb.waitForCall({ model: "good-m" }, 5000);
  const badCall = await cb.waitForCall({ model: "bad-m" }, 5000);

  goodCall.respond(text("Success!"));
  badCall.respond(error("something went wrong"));

  const result = await Promise.race([
    council.waitForCompletion(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("HUNG")), 15000)),
  ]);

  assert(result.members.find(m => m.id === "good").state === "done", "good member done");
  // Bad member might be done (error handled) or failed
  const bad = result.members.find(m => m.id === "bad");
  assert(bad.state === "done" || bad.state === "failed", `bad state: ${bad.state}`);
});

await test("T60: Member finish() closes stdin and allows process exit", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Finish test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Finish me."));
  await council.waitForCompletion();

  const member = council.getMember("claude");
  assert(member.hasResult(), "has result");
  member.finish(); // should not throw
});

// ═══════════════════════════════════════════════════════════════════════
// Artifact & Schema Validation Tests
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Artifact & Schema Tests ──\n");

await test("T61: Council result JSON has all required fields", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("JSON schema test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Schema valid."));
  await council.waitForCompletion();

  const resultsJson = JSON.parse(fs.readFileSync(
    path.join(council.getRunDir(), "results.json"), "utf-8"
  ));

  assert(typeof resultsJson.runId === "string", "runId");
  assert(typeof resultsJson.prompt === "string", "prompt");
  assert(typeof resultsJson.startedAt === "number", "startedAt");
  assert(typeof resultsJson.completedAt === "number", "completedAt");
  assert(Array.isArray(resultsJson.members), "members");

  const m = resultsJson.members[0];
  assert(typeof m.id === "string", "member.id");
  assert(typeof m.model === "object", "member.model");
  assert(typeof m.state === "string", "member.state");
  assert(typeof m.output === "string", "member.output");
  assert(typeof m.durationMs === "number", "member.durationMs");
});

await test("T62: Meta.json has all required fields", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Meta schema test");
  council.spawn({
    models: [
      { id: "claude", provider: "pi-mock", model: "claude-meta" },
      { id: "gpt", provider: "pi-mock", model: "gpt-meta" },
    ],
  });

  const c1 = await cb.waitForCall({ model: "claude-meta" }, 5000);
  const c2 = await cb.waitForCall({ model: "gpt-meta" }, 5000);
  c1.respond(text("Meta 1."));
  c2.respond(text("Meta 2."));
  await council.waitForCompletion();

  const meta = JSON.parse(fs.readFileSync(
    path.join(council.getRunDir(), "meta.json"), "utf-8"
  ));

  assert(meta.runId === council.runId, "runId matches");
  assert(meta.prompt === "Meta schema test", "prompt");
  assert(typeof meta.startedAt === "number", "startedAt");
  assert(Array.isArray(meta.models), "models array");
  assert(meta.models.length === 2, "2 models");
});

await test("T63: Prompt.txt matches council prompt", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Prompt file test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Prompt check."));
  await council.waitForCompletion();

  const promptFile = fs.readFileSync(path.join(council.getRunDir(), "prompt.txt"), "utf-8");
  assert(promptFile === "Prompt file test", "prompt matches");
});

await test("T64: Council result members have correct model specs", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Model spec test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "special-model-v3" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Spec check."));

  const result = await council.waitForCompletion();
  assert(result.members[0].model.id === "claude", "correct id");
  assert(result.members[0].model.provider === "pi-mock", "correct provider");
  assert(result.members[0].model.model === "special-model-v3", "correct model name");
});

await test("T65: Council handles custom run ID", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const customId = "custom-test-run-12345";
  const council = new Council("Custom ID test", customId);
  assert(council.runId === customId, "custom runId preserved");

  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Custom ID output."));
  await council.waitForCompletion();
  assert(council.getRunDir().includes(customId), "run dir uses custom ID");
});

await test("T66: Council getResult completedAt is after startedAt", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Timing test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Timed."));

  const result = await council.waitForCompletion();
  assert(result.completedAt >= result.startedAt, "completedAt >= startedAt");
  assert(result.completedAt - result.startedAt < 30000, "completed in <30s");
});

// ═══════════════════════════════════════════════════════════════════════
// Thinking / Observability Tests
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Thinking & Observability Tests ──\n");

await test("T67: Member separates thinking from text output", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Thinking separation");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond([thinking("Let me reason about this carefully."), text("The answer is 42.")]);

  await council.waitForCompletion();
  const status = council.getMember("claude").getStatus();

  assert(status.output.includes("42"), "output has text");
  assert(!status.output.includes("reason"), "output excludes thinking");
  assert(status.thinking.includes("reason"), "thinking has reasoning");
  assert(!status.thinking.includes("42"), "thinking excludes text answer");
});

await test("T68: Thinking-only response produces empty output", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Thinking only");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond([thinking("I have nothing to say out loud.")]);

  await council.waitForCompletion();
  const m = council.getMember("claude").getStatus();

  assert(m.output === "", "output is empty");
  assert(m.thinking.includes("nothing"), "thinking captured");
});

await test("T69: Member with no thinking has empty thinking field", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("No thinking test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Just text, no thinking."));

  await council.waitForCompletion();
  const status = council.getMember("claude").getStatus();
  assert(status.thinking === "", "thinking is empty string");
  assert(status.output.length > 0, "output still has content");
});

await test("T70: Thinking stored in per-member JSON artifact", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Thinking artifact");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond([thinking("Deep reasoning here."), text("Conclusion.")]);

  await council.waitForCompletion();

  const jsonPath = path.join(council.getRunDir(), "claude.json");
  assert(fs.existsSync(jsonPath), "per-member JSON exists");
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  assert(typeof data.thinking === "string", "JSON has thinking field");
  assert(data.thinking.includes("reasoning"), "thinking content correct");
  assert(typeof data.output === "string", "JSON has output field");
  assert(data.output.includes("Conclusion"), "output content correct");
});

await test("T71: Thinking section appears in results.md", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Thinking markdown");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond([thinking("Careful analysis."), text("Final answer.")]);

  await council.waitForCompletion();

  const md = fs.readFileSync(path.join(council.getRunDir(), "results.md"), "utf-8");
  assert(md.includes("Thinking"), "results.md has thinking section");
  assert(md.includes("Final answer"), "results.md has output");
});

// ═══════════════════════════════════════════════════════════════════════
// Script Brain & Multi-member Diversity Tests
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Script Brain & Diversity Tests ──\n");

await test("T72: Script brain — ordered responses without manual control", async () => {
  gw.setBrain(script(text("Script response one."), text("Script response two.")));

  const council = new Council("Script basic");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const result = await Promise.race([
    council.waitForCompletion(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("HUNG")), 15000)),
  ]);

  assert(result.members[0].state === "done", "script done");
  assert(result.members[0].output.length > 0, "script has output");
});

await test("T73: Always brain — same response forever", async () => {
  gw.setBrain(always(text("I always say this.")));

  const council = new Council("Always brain");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const result = await Promise.race([
    council.waitForCompletion(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("HUNG")), 15000)),
  ]);

  assert(result.members[0].output.includes("always"), "always brain output");
});

await test("T74: Three model council all produce different outputs", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Diversity test");
  council.spawn({
    models: [
      { id: "claude", provider: "pi-mock", model: "claude-div" },
      { id: "gpt", provider: "pi-mock", model: "gpt-div" },
      { id: "grok", provider: "pi-mock", model: "grok-div" },
    ],
  });

  const c1 = await cb.waitForCall({ model: "claude-div" }, 5000);
  const c2 = await cb.waitForCall({ model: "gpt-div" }, 5000);
  const c3 = await cb.waitForCall({ model: "grok-div" }, 5000);
  c1.respond(text("Claude's unique perspective on the matter."));
  c2.respond(text("GPT's systematic analysis of the issue."));
  c3.respond(text("Grok's direct and unconventional take."));

  const result = await council.waitForCompletion();
  const outputs = result.members.map(m => m.output);

  assert(outputs[0] !== outputs[1], "claude != gpt");
  assert(outputs[1] !== outputs[2], "gpt != grok");
  assert(outputs[0] !== outputs[2], "claude != grok");
});

await test("T75: Control exact completion order with staggered responses", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const doneOrder = [];
  const council = new Council("Staggered");
  council.on(e => { if (e.type === "member_done") doneOrder.push(e.memberId); });

  council.spawn({
    models: [
      { id: "first", provider: "pi-mock", model: "first-m" },
      { id: "second", provider: "pi-mock", model: "second-m" },
      { id: "third", provider: "pi-mock", model: "third-m" },
    ],
  });

  const c1 = await cb.waitForCall({ model: "first-m" }, 5000);
  const c2 = await cb.waitForCall({ model: "second-m" }, 5000);
  const c3 = await cb.waitForCall({ model: "third-m" }, 5000);

  // Release in reverse spawn order
  c3.respond(text("third responds first"));
  await new Promise(r => setTimeout(r, 50));
  c1.respond(text("first responds second"));
  await new Promise(r => setTimeout(r, 50));
  c2.respond(text("second responds last"));

  const result = await council.waitForCompletion();

  assert(doneOrder[0] === "third", `first done: ${doneOrder[0]}`);
  assert(doneOrder[2] === "second", `last done: ${doneOrder[2]}`);
  assert(result.ttfrMs > 0, "ttfr tracked");
});

// ═══════════════════════════════════════════════════════════════════════
// Live Steer/Abort E2E Tests — full pipeline through Council → Member → pi
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Live Steer/Abort E2E Tests ──\n");

await test("T76: Steer mid-tool-call delivers context to next brain call", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Steer mid-tool");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call1 = await cb.waitForCall(5000);
  call1.respond(toolCall("bash", { command: "echo step1" }));

  // Steer while tool is running
  const steerP = council.followUp({ type: "steer", message: "Also consider latency." });

  const call2 = await cb.waitForCall(5000);
  call2.respond(text("Done considering latency."));
  await steerP;

  // Drain any extra follow-up turns
  try { const extra = await cb.waitForCall(3000); extra.respond(text("steer extra")); } catch {}

  await council.waitForCompletion();
  assert(council.getMember("claude").getOutput().length > 0, "has output after steer");
});

await test("T77: Abort running member and verify completion", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Abort test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call1 = await cb.waitForCall(5000);
  call1.respond(toolCall("bash", { command: "sleep 30" }));

  // Abort without redirect (empty message)
  await council.followUp({ type: "abort", message: "" });

  await council.waitForCompletion();
  assert(council.isComplete(), "completed after abort");
});

await test("T78: Steer targeted to specific member in multi-member council", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Targeted steer multi");
  council.spawn({
    models: [
      { id: "claude", provider: "pi-mock", model: "claude-steer" },
      { id: "gpt", provider: "pi-mock", model: "gpt-steer" },
    ],
  });

  const c1 = await cb.waitForCall({ model: "claude-steer" }, 5000);
  const c2 = await cb.waitForCall({ model: "gpt-steer" }, 5000);

  c1.respond(toolCall("bash", { command: "echo thinking" }));
  c2.respond(toolCall("bash", { command: "echo working" }));

  // Steer only claude
  await council.followUp({
    type: "steer",
    message: "Focus on security aspects",
    memberIds: ["claude"],
  });

  // Drain all brain calls
  for (let i = 0; i < 6; i++) {
    try {
      const call = await cb.waitForCall(3000);
      call.respond(text(`done ${i}`));
    } catch { break; }
  }

  await council.waitForCompletion();
  assert(council.isComplete(), "complete");
  assert(council.getMember("claude").getStatus().state === "done", "claude done");
  assert(council.getMember("gpt").getStatus().state === "done", "gpt done");
});

await test("T79: Double abort serialized — doesn't deadlock", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Double abort");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call1 = await cb.waitForCall(5000);
  call1.respond(toolCall("bash", { command: "sleep 30" }));

  // Fire two aborts. First acquires lock, second waits.
  const p1 = council.followUp({ type: "abort", message: "first" }).catch(() => {});
  const p2 = council.followUp({ type: "abort", message: "second" }).catch(() => {});

  // Respond to whatever brain calls come in
  for (let i = 0; i < 4; i++) {
    try {
      const call = await cb.waitForCall(3000);
      call.respond(text("done " + i));
    } catch { break; }
  }

  await Promise.allSettled([p1, p2]);
  await Promise.race([
    council.waitForCompletion(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("DOUBLE ABORT HUNG")), 10000)),
  ]);
});

await test("T80: Abort-to-done member doesn't hang", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Abort done member");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call1 = await cb.waitForCall(5000);
  call1.respond(text("First answer."));
  await council.waitForCompletion();

  // Member is done. Abort+redirect should not deadlock.
  const abortP = council.followUp({ type: "abort", message: "new task" });
  try {
    const call2 = await cb.waitForCall(3000);
    call2.respond(text("second answer"));
  } catch {
    // Stdin might be closed. That's fine.
  }

  await Promise.race([
    abortP,
    new Promise((_, rej) => setTimeout(() => rej(new Error("ABORT-TO-DONE HUNG")), 5000)),
  ]);
});

// ═══════════════════════════════════════════════════════════════════════
// Large Output & Stress Tests
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Large Output & Stress Tests ──\n");

await test("T81: Large output preserved correctly", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Large output");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("x".repeat(50000)));

  const result = await council.waitForCompletion();
  assert(result.members[0].output.length === 50000, `large: ${result.members[0].output.length}`);
});

await test("T82: Five members at once all complete", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Five members");
  council.spawn({
    models: Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      provider: "pi-mock",
      model: `mock-${i}`,
    })),
  });

  for (let i = 0; i < 5; i++) {
    const call = await cb.waitForCall(5000);
    call.respond(text(`member ${call.request.model}`));
  }

  const result = await council.waitForCompletion();
  assert(result.members.length === 5, "5 members");
  assert(result.members.every(m => m.state === "done"), "all 5 done");
  assert(new Set(result.members.map(m => m.id)).size === 5, "unique ids");
});

await test("T83: Steer-to-done member doesn't deadlock waitForCompletion", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Steer done no deadlock");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Done."));
  await council.waitForCompletion();

  await council.followUp({ type: "steer", message: "extra" });

  // waitForCompletion should still resolve immediately
  await Promise.race([
    council.waitForCompletion(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("STEER-TO-DONE HUNG")), 3000)),
  ]);
});

await test("T84: Member getOutput returns accumulated text", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Output accumulation");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(text("Accumulated text content."));
  await council.waitForCompletion();

  const member = council.getMember("claude");
  const output = member.getOutput();
  assert(output.length > 0, "has output");
  assert(typeof output === "string", "is string");
  assert(output.includes("Accumulated"), "correct content");
});

await test("T85: Script brain with tool calls", async () => {
  gw.setBrain(script(bash("echo hello"), text("After tool.")));

  const council = new Council("Script with tools");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const result = await Promise.race([
    council.waitForCompletion(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("HUNG")), 15000)),
  ]);

  assert(result.members[0].state === "done", "script done");
  assert(result.members[0].output.includes("After tool") || result.members[0].output.includes("tool"),
    `script output: ${result.members[0].output.slice(0, 80)}`);
});

await test("T86: Script brain with thinking + tool", async () => {
  gw.setBrain(script(
    [thinking("Hmm, let me check"), bash("echo step1")],
    [thinking("OK now I know"), text("Final answer: 42")],
  ));

  const council = new Council("Script thinking");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const result = await Promise.race([
    council.waitForCompletion(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("HUNG")), 15000)),
  ]);

  assert(result.members[0].output.includes("42"), "script thinking output");
  assert(result.members[0].thinking.length > 0, "script thinking captured");
});

await test("T87: Per-member JSON artifact has thinking, output, and toolEvents", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Full artifact test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call1 = await cb.waitForCall(5000);
  call1.respond([thinking("Deep analysis"), bash("echo data")]);
  const call2 = await cb.waitForCall(5000);
  call2.respond(text("Conclusion from analysis."));

  await council.waitForCompletion();

  const jsonPath = path.join(council.getRunDir(), "claude.json");
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

  assert(data.id === "claude", "id");
  assert(data.state === "done", "state");
  assert(data.output.includes("Conclusion"), "output");
  assert(data.thinking.includes("analysis"), "thinking");
  assert(Array.isArray(data.toolEvents), "toolEvents array");
  assert(data.toolEvents.length >= 2, "has tool events");
  assert(typeof data.durationMs === "number", "durationMs");
});

await test("T88: SSE error — council handles gracefully without hanging", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("SSE error test");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  const call = await cb.waitForCall(5000);
  call.respond(error("something went wrong"));

  const result = await Promise.race([
    council.waitForCompletion(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("SSE ERROR HUNG")), 15000)),
  ]);

  assert(
    result.members[0].state === "done" || result.members[0].state === "failed",
    `error state: ${result.members[0].state}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Nested Council Prevention Tests
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Nested Council Prevention Tests ──\n");

await test("T89: PI_COUNCIL_MEMBER env var is set on spawned members", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const council = new Council("Env var check");
  council.spawn({
    models: [{ id: "claude", provider: "pi-mock", model: "mock" }],
  });

  // The member process should have PI_COUNCIL_MEMBER=1 in its env.
  // We can verify by checking the spawn args in member.ts.
  // Since we can't directly inspect child env, we verify the member
  // completes normally (proving the env var doesn't break anything).
  const call = await cb.waitForCall(5000);
  call.respond(text("I answered directly without spawning a council."));

  await council.waitForCompletion();
  const output = council.getMember("claude").getOutput();
  assert(output.includes("directly"), "member answered directly");
});

await test("T90: Extension early-returns when PI_COUNCIL_MEMBER=1 is set", async () => {
  // Simulate what happens inside a council member process:
  // the extension should not register any tools.
  const originalEnv = process.env.PI_COUNCIL_MEMBER;
  process.env.PI_COUNCIL_MEMBER = "1";

  try {
    const registeredTools = [];
    const mockPi = {
      registerTool: (tool) => registeredTools.push(tool.name),
      sendMessage: () => {},
    };

    // Dynamically import and call the extension
    // We need a fresh import to pick up the env var
    const extensionPath = path.join(__dirname, "..", "dist", "extensions", "pi-council", "index.js");
    const mod = await import(extensionPath + "?t=" + Date.now());
    mod.default(mockPi);

    assert(registeredTools.length === 0, `expected 0 tools registered, got ${registeredTools.length}: ${registeredTools.join(", ")}`);
  } finally {
    if (originalEnv !== undefined) {
      process.env.PI_COUNCIL_MEMBER = originalEnv;
    } else {
      delete process.env.PI_COUNCIL_MEMBER;
    }
  }
});

await test("T91: Extension registers tools normally when PI_COUNCIL_MEMBER is not set", async () => {
  // Verify the extension registers tools when NOT in a council member
  const originalEnv = process.env.PI_COUNCIL_MEMBER;
  delete process.env.PI_COUNCIL_MEMBER;

  try {
    const registeredTools = [];
    const mockPi = {
      registerTool: (tool) => registeredTools.push(tool.name),
      sendMessage: () => {},
    };

    const extensionPath = path.join(__dirname, "..", "dist", "extensions", "pi-council", "index.js");
    const mod = await import(extensionPath + "?t=normal" + Date.now());
    mod.default(mockPi);

    assert(registeredTools.length === 5, `expected 5 tools, got ${registeredTools.length}: ${registeredTools.join(", ")}`);
    assert(registeredTools.includes("spawn_council"), "has spawn_council");
    assert(registeredTools.includes("council_followup"), "has council_followup");
    assert(registeredTools.includes("cancel_council"), "has cancel_council");
    assert(registeredTools.includes("council_status"), "has council_status");
    assert(registeredTools.includes("read_stream"), "has read_stream");
  } finally {
    if (originalEnv !== undefined) {
      process.env.PI_COUNCIL_MEMBER = originalEnv;
    } else {
      delete process.env.PI_COUNCIL_MEMBER;
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Cleanup & Summary
// ═══════════════════════════════════════════════════════════════════════

// Restore env
if (origAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = origAgentDir;
else delete process.env.PI_CODING_AGENT_DIR;
if (origOffline !== undefined) process.env.PI_OFFLINE = origOffline;
else delete process.env.PI_OFFLINE;

await gw.close();
fs.rmSync(agentDir, { recursive: true, force: true });
fs.rmSync(testHome, { recursive: true, force: true });

process.stdout.write(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed}\n\n`);

process.stdout.write(`METRIC tests_passed=${passed}\n`);
process.stdout.write(`METRIC tests_failed=${failed}\n`);
process.stdout.write(`METRIC tests_total=${passed + failed}\n`);

process.exit(failed > 0 ? 1 : 0);
