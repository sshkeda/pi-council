#!/usr/bin/env node

/**
 * Integration tests — real pi processes, controllable brain, zero timing hacks.
 *
 * 3 scenarios that cover everything:
 *   1. Full lifecycle: spawn → stream → thinking → tools → complete → artifacts
 *   2. Follow-ups: steer, abort+redirect, abort-to-done, double abort
 *   3. Multi-member: mixed timing, cancel one, timeout, status polling
 */

import { createGateway, createControllableBrain, text, thinking, toolCall } from "pi-mock";
import { Council } from "../dist/src/core/council.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
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

// ─── Shared setup ────────────────────────────────────────────────────

function createAgentDir(gatewayUrl) {
  const dir = mkdtempSync(join(tmpdir(), "pi-council-test-"));
  writeFileSync(join(dir, "models.json"), JSON.stringify({
    providers: {
      "pi-mock": { baseUrl: `${gatewayUrl}/v1`, api: "anthropic-messages", apiKey: "k", models: [{ id: "mock" }] },
      anthropic: { baseUrl: `${gatewayUrl}/v1`, apiKey: "k" },
      "openai-codex": { baseUrl: `${gatewayUrl}/v1`, apiKey: "k" },
      openai: { baseUrl: `${gatewayUrl}/v1`, apiKey: "k" },
      google: { baseUrl: `${gatewayUrl}/v1beta`, apiKey: "k" },
      xai: { baseUrl: `${gatewayUrl}/v1`, apiKey: "k" },
      openrouter: { baseUrl: `${gatewayUrl}/v1`, apiKey: "k" },
    },
  }));
  writeFileSync(join(dir, "settings.json"), "{}");
  return dir;
}

const gw = await createGateway({ brain: () => text("unused"), port: 0, default: "allow" });
const agentDir = createAgentDir(gw.url);
const origDir = process.env.PI_CODING_AGENT_DIR;
const origOffline = process.env.PI_OFFLINE;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";

process.stdout.write("\n🧪 Integration Tests (pi-mock + controllable brain)\n\n");

// ═════════════════════════════════════════════════════════════════════
// Scenario 1: Full lifecycle
// ═════════════════════════════════════════════════════════════════════

await test("S1: spawn → thinking → tool call → text → complete → artifacts", async () => {
  let cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const c = new Council("lifecycle test");
  const events = [];
  c.on((e) => events.push(e.type));
  c.spawn({ models: [{ id: "m0", provider: "pi-mock", model: "mock" }] });

  // ── Turn 1: thinking + tool call
  const call1 = await cb.waitForCall(3000);
  assert(call1.request.messages.length > 0, "brain got messages");
  call1.respond([thinking("Let me search for this"), toolCall("bash", { command: "echo data" })]);

  // ── Turn 2: tool result → thinking + final text
  const call2 = await cb.waitForCall(3000);
  // pi sent the tool result back — verify it's in the messages
  const lastMsg = call2.request.messages[call2.request.messages.length - 1];
  assert(lastMsg.role === "tool" || lastMsg.role === "user", `tool result sent back: ${lastMsg.role}`);
  call2.respond([thinking("Now I can answer"), text("Here are the results.")]);

  // ── Wait for completion
  const r = await c.waitForCompletion();
  const m = r.members[0];

  // Output: clean text only
  assert(m.output.includes("results"), `output: ${m.output}`);
  assert(!m.output.includes("search"), "no thinking in output");

  // Thinking: captured separately
  assert(m.thinking.length > 0, "thinking captured");

  // Tool events tracked
  assert(m.toolEvents.length >= 2, `tool events: ${m.toolEvents.length}`);

  // Events fired in order
  assert(events.includes("member_started"), "started event");
  assert(events.includes("member_done"), "done event");
  assert(events.includes("council_complete"), "complete event");
  assert(events.indexOf("member_started") < events.indexOf("member_done"), "order: started < done");

  // Artifacts written
  const memberJson = join(c.getRunDir(), "m0.json");
  assert(existsSync(memberJson), "member json");
  const data = JSON.parse(readFileSync(memberJson, "utf-8"));
  assert(data.output.includes("results"), "output in json");
  assert(data.thinking.length > 0, "thinking in json");
  assert(Array.isArray(data.toolEvents), "toolEvents in json");

  const md = readFileSync(join(c.getRunDir(), "results.md"), "utf-8");
  assert(md.includes("results"), "output in md");
  assert(md.includes("Thinking"), "thinking section in md");

  // Thinking-only response produces empty output
  cb = createControllableBrain(); gw.setBrain(cb.brain);
  const c2 = new Council("thinking only");
  c2.spawn({ models: [{ id: "m0", provider: "pi-mock", model: "mock" }] });
  const call3 = await cb.waitForCall(3000);
  call3.respond([thinking("I have nothing to say")]);
  const r2 = await c2.waitForCompletion();
  assert(r2.members[0].output === "", "empty output for thinking-only");
  assert(r2.members[0].thinking.includes("nothing"), "thinking captured");

  // Large output
  cb = createControllableBrain(); gw.setBrain(cb.brain);
  const c3 = new Council("big output");
  c3.spawn({ models: [{ id: "m0", provider: "pi-mock", model: "mock" }] });
  const call4 = await cb.waitForCall(3000);
  call4.respond(text("x".repeat(50000)));
  const r3 = await c3.waitForCompletion();
  assert(r3.members[0].output.length === 50000, `large: ${r3.members[0].output.length}`);
});

// ═════════════════════════════════════════════════════════════════════
// Scenario 2: Follow-ups (steer, abort, edge cases)
// ═════════════════════════════════════════════════════════════════════

await test("S2: steer + abort + abort-to-done + double abort", async () => {
  let cb = createControllableBrain();
  gw.setBrain(cb.brain);

  // ── Steer mid-tool-call
  const c1 = new Council("steer test");
  c1.spawn({ models: [{ id: "m0", provider: "pi-mock", model: "mock" }] });
  const call1 = await cb.waitForCall(3000);
  call1.respond(toolCall("bash", { command: "echo step1" }));
  const call2 = await cb.waitForCall(3000);
  const steerP = c1.followUp({ type: "steer", message: "also consider security" });
  call2.respond(text("done with steer context"));
  await steerP;
  // Steer triggers a follow-up turn — drain it
  try { const extra = await cb.waitForCall(3000); extra.respond(text("steer done")); } catch {}
  const r1 = await c1.waitForCompletion();
  assert(r1.members[0].output.length > 0, "steer: got output");

  // ── Abort + redirect: running member gets redirected, produces new output
  cb = createControllableBrain(); gw.setBrain(cb.brain);
  const c2 = new Council("abort redirect");
  c2.spawn({ models: [{ id: "m0", provider: "pi-mock", model: "mock" }] });
  const call3 = await cb.waitForCall(3000);
  call3.respond(toolCall("bash", { command: "sleep 30" }));
  // Tool is executing. Abort + redirect — don't await, need to handle the brain call
  const abortP = c2.followUp({ type: "abort", message: "Do this instead." });
  // The abort kills the turn, then re-prompts. Brain gets the new prompt.
  const call4 = await cb.waitForCall(3000);
  // Brain got a new call after abort — that's the redirect working
  assert(call4.index > 0 || call4.request.messages.length > 0, "redirect prompt received");
  call4.respond(text("redirected!"));
  await abortP;
  const r2 = await c2.waitForCompletion();
  assert(r2.members[0].output.includes("redirected"), `abort redirect: ${r2.members[0].output}`);

  // ── Abort to done member: doesn't hang
  cb = createControllableBrain(); gw.setBrain(cb.brain);
  const c3 = new Council("abort done");
  c3.spawn({ models: [{ id: "m0", provider: "pi-mock", model: "mock" }] });
  const call5 = await cb.waitForCall(3000);
  call5.respond(text("first answer"));
  await c3.waitForCompletion();
  // Member is done. Abort+redirect should not deadlock.
  const abortDoneP = c3.followUp({ type: "abort", message: "new task" });
  // If member is done and stdin still open, brain gets new prompt
  try {
    const call6 = await cb.waitForCall(3000);
    call6.respond(text("second answer"));
  } catch {
    // Stdin might be closed (onComplete called finish). That's fine.
  }
  await Promise.race([
    abortDoneP,
    new Promise((_, rej) => setTimeout(() => rej(new Error("ABORT-TO-DONE HUNG")), 5000)),
  ]);

  // ── Steer to done member: doesn't deadlock waitForCompletion
  cb = createControllableBrain(); gw.setBrain(cb.brain);
  const c4 = new Council("steer done");
  c4.spawn({ models: [{ id: "m0", provider: "pi-mock", model: "mock" }] });
  const call7 = await cb.waitForCall(3000);
  call7.respond(text("done"));
  await c4.waitForCompletion();
  await c4.followUp({ type: "steer", message: "extra" });
  // waitForCompletion should still resolve immediately
  await Promise.race([
    c4.waitForCompletion(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("STEER-TO-DONE HUNG")), 3000)),
  ]);

  // ── Double abort: serialized, doesn't deadlock
  cb = createControllableBrain(); gw.setBrain(cb.brain);
  const c5 = new Council("double abort");
  c5.spawn({ models: [{ id: "m0", provider: "pi-mock", model: "mock" }] });
  const call8 = await cb.waitForCall(3000);
  call8.respond(toolCall("bash", { command: "sleep 30" }));
  // Fire two aborts. First acquires lock, second waits.
  const p1 = c5.followUp({ type: "abort", message: "first" }).catch(() => {});
  const p2 = c5.followUp({ type: "abort", message: "second" }).catch(() => {});
  // Respond to whatever brain calls come in
  for (let i = 0; i < 4; i++) {
    try {
      const call = await cb.waitForCall(3000);
      call.respond(text("done " + i));
    } catch { break; }
  }
  await Promise.allSettled([p1, p2]);
  await Promise.race([
    c5.waitForCompletion(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("DOUBLE ABORT HUNG")), 5000)),
  ]);

  // ── Abort empty message = kill switch
  cb = createControllableBrain(); gw.setBrain(cb.brain);
  const c6 = new Council("kill switch");
  c6.spawn({ models: [{ id: "m0", provider: "pi-mock", model: "mock" }] });
  const call12 = await cb.waitForCall(3000);
  call12.respond(toolCall("bash", { command: "sleep 30" }));
  await c6.followUp({ type: "abort", message: "" });
  await c6.waitForCompletion();
  assert(r1.members[0].state === "done" || r1.members[0].state === "cancelled", "kill switch");
});

// ═════════════════════════════════════════════════════════════════════
// Scenario 3: Multi-member (timing, cancel, timeout, providers)
// ═════════════════════════════════════════════════════════════════════

await test("S3: multi-member: mixed timing + cancel + timeout + status + providers", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  // ── 3 members with unique model names for identity
  const c1 = new Council("multi timing");
  c1.spawn({ models: [
    { id: "fast", provider: "pi-mock", model: "mock-fast" },
    { id: "medium", provider: "anthropic", model: "claude-sonnet-4-20250514" },
    { id: "slow", provider: "pi-mock", model: "mock-slow" },
  ] });

  // All 3 call brain. Respond to them in non-spawn order.
  const calls = [];
  for (let i = 0; i < 3; i++) calls.push(await cb.waitForCall(3000));

  // Check status mid-flight: all should be running
  const status1 = c1.getStatus();
  assert(status1.members.length === 3, "3 members");
  assert(status1.finishedCount === 0, "none done yet");

  // Respond to calls[1] first (out of order)
  calls[1].respond(text("medium finished"));
  // Wait for member_done event
  await new Promise((resolve) => {
    c1.on((e) => { if (e.type === "member_done") resolve(); });
  });

  const status2 = c1.getStatus();
  assert(status2.finishedCount === 1, "1 done");

  // Respond to remaining
  calls[0].respond([thinking("fast thinking"), text("fast done")]);
  calls[2].respond(text("slow done"));

  const r1 = await c1.waitForCompletion();
  assert(r1.members.every((m) => m.state === "done"), "all done");
  assert(r1.members.every((m) => m.output.length > 0), "all have output");
  assert(r1.ttfrMs > 0, "ttfr tracked");

  // ── Cancel one member while others complete (unique model names)
  const c2 = new Council("cancel one");
  c2.spawn({ models: [
    { id: "keep", provider: "pi-mock", model: "mock-keep" },
    { id: "kill", provider: "pi-mock", model: "mock-kill" },
  ] });
  const callA = await cb.waitForCall(3000);
  const callB = await cb.waitForCall(3000);
  // Cancel "kill" before responding
  c2.cancel(["kill"]);
  callA.respond(text("survived"));
  // callB's response will be ignored (process killed)
  try { callB.respond(text("ignored")); } catch {}
  const r2 = await c2.waitForCompletion();
  assert(r2.members.find((m) => m.id === "keep").state === "done", "keep done");
  assert(r2.members.find((m) => m.id === "kill").state === "cancelled", "kill cancelled");

  // ── Member timeout
  const c3 = new Council("timeout test");
  c3.spawn({
    models: [{ id: "m0", provider: "pi-mock", model: "mock" }],
    memberTimeoutMs: 3000,
  });
  const callT = await cb.waitForCall(3000);
  // Don't respond — let timeout fire
  const r3 = await c3.waitForCompletion();
  assert(r3.members[0].state === "cancelled", "timed out and cancelled");

  // ── Status polling during active work
  const c4 = new Council("poll test");
  c4.spawn({ models: [{ id: "m0", provider: "pi-mock", model: "mock" }] });
  const callP1 = await cb.waitForCall(3000);

  // Status while waiting on brain
  const s1 = c4.getStatus();
  assert(s1.members[0].state === "running", "running during brain call");

  callP1.respond(toolCall("bash", { command: "echo test" }));
  const callP2 = await cb.waitForCall(3000);

  // Status after tool call
  const s2 = c4.getStatus();
  assert(s2.members[0].toolEvents.length >= 2, `tools tracked: ${s2.members[0].toolEvents.length}`);

  callP2.respond(text("poll done"));
  await c4.waitForCompletion();
  const s3 = c4.getStatus();
  assert(s3.isComplete, "complete after done");

  // ── 5 members at once (unique model names)
  const c5 = new Council("five members");
  c5.spawn({ models: Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, provider: "pi-mock", model: `mock-${i}` })) });
  for (let i = 0; i < 5; i++) {
    const call = await cb.waitForCall(3000);
    call.respond(text(`member ${i}`));
  }
  const r5 = await c5.waitForCompletion();
  assert(r5.members.length === 5, "5 members");
  assert(r5.members.every((m) => m.state === "done"), "all 5 done");
  assert(new Set(r5.members.map((m) => m.id)).size === 5, "unique ids");
});

// ═════════════════════════════════════════════════════════════════════
// Scenario 4: Filtered waitForCall — deterministic per-member control
// ═════════════════════════════════════════════════════════════════════

await test("S4: filtered waitForCall — per-member deterministic responses", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  // ── 3 members with unique model names. Brain can address each by name.
  const c1 = new Council("filtered brain test");
  c1.spawn({ models: [
    { id: "claude", provider: "pi-mock", model: "claude-test" },
    { id: "gpt", provider: "pi-mock", model: "gpt-test" },
    { id: "grok", provider: "pi-mock", model: "grok-test" },
  ] });

  // Wait for each member BY NAME — order doesn't matter!
  // Even if grok's call arrives first, we can wait for claude specifically.
  const grokCall = await cb.waitForCall({ model: "grok-test" }, 3000);
  const claudeCall = await cb.waitForCall({ model: "claude-test" }, 3000);
  const gptCall = await cb.waitForCall({ model: "gpt-test" }, 3000);

  // Verify identity on each call via request.model
  assert(claudeCall.request.model === "claude-test", `claude model: ${claudeCall.request.model}`);
  assert(gptCall.request.model === "gpt-test", `gpt model: ${gptCall.request.model}`);
  assert(grokCall.request.model === "grok-test", `grok model: ${grokCall.request.model}`);

  // Respond with member-specific content — fully deterministic
  claudeCall.respond(text("I am Claude's response"));
  gptCall.respond(text("I am GPT's response"));
  grokCall.respond(text("I am Grok's response"));

  const r1 = await c1.waitForCompletion();
  assert(r1.members.find((m) => m.id === "claude").output.includes("Claude"), "claude got claude response");
  assert(r1.members.find((m) => m.id === "gpt").output.includes("GPT"), "gpt got gpt response");
  assert(r1.members.find((m) => m.id === "grok").output.includes("Grok"), "grok got grok response");

  // ── Predicate filter: wait for any member whose model contains "gpt"
  const c2 = new Council("predicate filter test");
  c2.spawn({ models: [
    { id: "a", provider: "pi-mock", model: "alpha-model" },
    { id: "b", provider: "pi-mock", model: "gpt-turbo" },
  ] });

  const gptLike = await cb.waitForCall((req) => req.model.includes("gpt"), 3000);
  assert(gptLike.request.model === "gpt-turbo", `predicate matched: ${gptLike.request.model}`);
  gptLike.respond(text("gpt matched"));

  const other = await cb.waitForCall(3000); // unfiltered — gets whatever's left
  assert(other.request.model === "alpha-model", `remaining: ${other.request.model}`);
  other.respond(text("alpha matched"));

  const r2 = await c2.waitForCompletion();
  assert(r2.members.find((m) => m.id === "b").output.includes("gpt"), "predicate: b got gpt response");
  assert(r2.members.find((m) => m.id === "a").output.includes("alpha"), "predicate: a got alpha response");

  // ── Multi-turn: filtered waitForCall across tool call rounds
  const c3 = new Council("multi-turn filtered");
  c3.spawn({ models: [
    { id: "worker", provider: "pi-mock", model: "worker-model" },
    { id: "thinker", provider: "pi-mock", model: "thinker-model" },
  ] });

  // Both members call brain. Wait for each by name.
  const workerCall1 = await cb.waitForCall({ model: "worker-model" }, 3000);
  const thinkerCall1 = await cb.waitForCall({ model: "thinker-model" }, 3000);

  // Worker gets a tool call, thinker gets immediate text
  workerCall1.respond(toolCall("bash", { command: "echo hello" }));
  thinkerCall1.respond(text("Thought about it deeply."));

  // Worker comes back after tool execution — wait for it by name
  const workerCall2 = await cb.waitForCall({ model: "worker-model" }, 3000);
  workerCall2.respond(text("Worker done after tool."));

  const r3 = await c3.waitForCompletion();
  assert(r3.members.find((m) => m.id === "worker").output.includes("Worker done"), "worker multi-turn");
  assert(r3.members.find((m) => m.id === "thinker").output.includes("Thought"), "thinker single-turn");

  // ── pending() introspection
  const c4 = new Council("pending test");
  c4.spawn({ models: [
    { id: "x", provider: "pi-mock", model: "x-model" },
    { id: "y", provider: "pi-mock", model: "y-model" },
  ] });

  // Let both calls arrive, then check pending
  await new Promise((r) => setTimeout(r, 500));
  const pendingList = cb.pending();
  assert(pendingList.length === 2, `pending count: ${pendingList.length}`);
  assert(pendingList.some((p) => p.request.model === "x-model"), "x in pending");
  assert(pendingList.some((p) => p.request.model === "y-model"), "y in pending");

  // Now consume them
  const xCall = await cb.waitForCall({ model: "x-model" }, 3000);
  const yCall = await cb.waitForCall({ model: "y-model" }, 3000);
  xCall.respond(text("x done"));
  yCall.respond(text("y done"));
  await c4.waitForCompletion();
  assert(cb.pending().length === 0, "pending empty after consumption");
});

// ═════════════════════════════════════════════════════════════════════
// S5: Per-member abort targeting with identity
// ═════════════════════════════════════════════════════════════════════

await test("S5: abort one named member mid-tool while others stream independently", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const c = new Council("targeted abort");
  c.spawn({ models: [
    { id: "researcher", provider: "pi-mock", model: "researcher-model" },
    { id: "writer", provider: "pi-mock", model: "writer-model" },
    { id: "critic", provider: "pi-mock", model: "critic-model" },
  ] });

  // All 3 call brain. Get each by name.
  const researcherCall = await cb.waitForCall({ model: "researcher-model" }, 3000);
  const writerCall = await cb.waitForCall({ model: "writer-model" }, 3000);
  const criticCall = await cb.waitForCall({ model: "critic-model" }, 3000);

  // Researcher does a tool call (will be aborted)
  researcherCall.respond(toolCall("bash", { command: "sleep 30" }));

  // Writer and critic get immediate text answers
  writerCall.respond(text("Here is the draft."));
  criticCall.respond(text("The draft has issues."));

  // Wait for writer and critic to finish
  await new Promise((resolve) => {
    let n = 0;
    c.on((e) => { if (e.type === "member_done") { n++; if (n >= 2) resolve(); } });
  });

  // Verify writer and critic done, researcher still running
  const s = c.getStatus();
  const researcherStatus = s.members.find((m) => m.id === "researcher");
  const writerStatus = s.members.find((m) => m.id === "writer");
  const criticStatus = s.members.find((m) => m.id === "critic");
  assert(writerStatus.state === "done", "writer done");
  assert(criticStatus.state === "done", "critic done");
  assert(researcherStatus.state === "running", "researcher still running");

  // Abort ONLY researcher with redirect
  const abortP = c.followUp({ type: "abort", message: "Skip research. Just summarize.", memberIds: ["researcher"] });
  const redirectCall = await cb.waitForCall({ model: "researcher-model" }, 3000);
  assert(redirectCall.request.model === "researcher-model", "redirect went to researcher");
  redirectCall.respond(text("Summary without research."));
  await abortP;

  const r = await c.waitForCompletion();
  assert(r.members.every((m) => m.state === "done"), "all done");
  assert(r.members.find((m) => m.id === "researcher").output.includes("Summary"), "researcher got redirect output");
  assert(r.members.find((m) => m.id === "writer").output.includes("draft"), "writer output preserved");
  assert(r.members.find((m) => m.id === "critic").output.includes("issues"), "critic output preserved");
});

// ═════════════════════════════════════════════════════════════════════
// S6: Stagger responses — control exact completion order
// ═════════════════════════════════════════════════════════════════════

await test("S6: control exact completion order and verify TTFR + per-member timing", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const c = new Council("staggered");
  const doneOrder = [];
  c.on((e) => { if (e.type === "member_done") doneOrder.push(e.memberId); });
  c.spawn({ models: [
    { id: "first", provider: "pi-mock", model: "first-model" },
    { id: "second", provider: "pi-mock", model: "second-model" },
    { id: "third", provider: "pi-mock", model: "third-model" },
  ] });

  // Get all 3 calls
  const c1 = await cb.waitForCall({ model: "first-model" }, 3000);
  const c2 = await cb.waitForCall({ model: "second-model" }, 3000);
  const c3 = await cb.waitForCall({ model: "third-model" }, 3000);

  // Release in reverse spawn order
  c3.respond(text("third responds first"));
  await new Promise((r) => setTimeout(r, 50)); // tiny gap for event ordering
  c1.respond(text("first responds second"));
  await new Promise((r) => setTimeout(r, 50));
  c2.respond(text("second responds last"));

  const r = await c.waitForCompletion();

  // Verify completion order
  assert(doneOrder[0] === "third", `first done: ${doneOrder[0]}`);
  assert(doneOrder[2] === "second", `last done: ${doneOrder[2]}`);

  // TTFR should reflect the first completion
  assert(r.ttfrMs > 0, "ttfr set");

  // Each member has correct output
  assert(r.members.find((m) => m.id === "first").output.includes("second"), "first content correct");
  assert(r.members.find((m) => m.id === "third").output.includes("first"), "third content correct");
});

// ═════════════════════════════════════════════════════════════════════
// S7: Multi-turn per-member — different tool call depths
// ═════════════════════════════════════════════════════════════════════

await test("S7: members take different numbers of tool-call turns", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const c = new Council("multi-turn depth");
  c.spawn({ models: [
    { id: "shallow", provider: "pi-mock", model: "shallow-model" },
    { id: "deep", provider: "pi-mock", model: "deep-model" },
  ] });

  // Shallow: 1 turn, immediate text
  const shallow1 = await cb.waitForCall({ model: "shallow-model" }, 3000);
  shallow1.respond(text("Quick answer."));

  // Deep: 3 turns of tool calls
  const deep1 = await cb.waitForCall({ model: "deep-model" }, 3000);
  deep1.respond(toolCall("bash", { command: "echo step1" }));
  const deep2 = await cb.waitForCall({ model: "deep-model" }, 3000);
  deep2.respond(toolCall("bash", { command: "echo step2" }));
  const deep3 = await cb.waitForCall({ model: "deep-model" }, 3000);
  deep3.respond(toolCall("bash", { command: "echo step3" }));
  const deep4 = await cb.waitForCall({ model: "deep-model" }, 3000);
  deep4.respond(text("Deep answer after 3 tool calls."));

  const r = await c.waitForCompletion();

  const shallow = r.members.find((m) => m.id === "shallow");
  const deep = r.members.find((m) => m.id === "deep");

  assert(shallow.output.includes("Quick"), "shallow output");
  assert(deep.output.includes("Deep"), "deep output");
  assert(shallow.toolEvents.length === 0, "shallow: 0 tools");
  assert(deep.toolEvents.length >= 6, `deep: ${deep.toolEvents.length} tool events`); // 3 start + 3 end
  assert(deep.durationMs > shallow.durationMs, "deep took longer");
});

// ═════════════════════════════════════════════════════════════════════
// Scenario 8: Native Pi headers — identity via models.json headers
// ═════════════════════════════════════════════════════════════════════

await test("S8: brain sees Pi-native per-model headers from models.json", async () => {
  // Create a custom agent dir with per-model headers for identity
  const customDir = mkdtempSync(join(tmpdir(), "pi-council-headers-"));
  writeFileSync(join(customDir, "models.json"), JSON.stringify({
    providers: {
      "pi-mock": {
        baseUrl: `${gw.url}/v1`,
        api: "anthropic-messages",
        apiKey: "k",
        models: [
          { id: "researcher", headers: { "x-member-id": "researcher" } },
          { id: "writer", headers: { "x-member-id": "writer" } },
        ],
      },
    },
  }));
  writeFileSync(join(customDir, "settings.json"), "{}");

  // Point pi at the custom agent dir
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = customDir;

  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const c = new Council("headers identity test");
  c.spawn({ models: [
    { id: "researcher", provider: "pi-mock", model: "researcher" },
    { id: "writer", provider: "pi-mock", model: "writer" },
  ] });

  // Wait for calls — filter by header
  const researcherCall = await cb.waitForCall(
    (req) => req._headers?.["x-member-id"] === "researcher", 3000
  );
  const writerCall = await cb.waitForCall(
    (req) => req._headers?.["x-member-id"] === "writer", 3000
  );

  // Verify headers arrived on the request
  assert(researcherCall.request._headers?.["x-member-id"] === "researcher",
    `researcher header: ${researcherCall.request._headers?.["x-member-id"]}`);
  assert(writerCall.request._headers?.["x-member-id"] === "writer",
    `writer header: ${writerCall.request._headers?.["x-member-id"]}`);

  researcherCall.respond(text("Research findings."));
  writerCall.respond(text("Draft document."));

  const r = await c.waitForCompletion();
  assert(r.members.find((m) => m.id === "researcher").output.includes("Research"), "researcher output");
  assert(r.members.find((m) => m.id === "writer").output.includes("Draft"), "writer output");

  // Restore
  if (prevAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  else delete process.env.PI_CODING_AGENT_DIR;
  rmSync(customDir, { recursive: true, force: true });
});

// ─── Cleanup ─────────────────────────────────────────────────────────

if (origDir !== undefined) process.env.PI_CODING_AGENT_DIR = origDir;
else delete process.env.PI_CODING_AGENT_DIR;
if (origOffline !== undefined) process.env.PI_OFFLINE = origOffline;
else delete process.env.PI_OFFLINE;
await gw.close();
rmSync(agentDir, { recursive: true, force: true });

process.stdout.write(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed}\n\n`);
process.exit(failed > 0 ? 1 : 0);
