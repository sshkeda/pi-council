#!/usr/bin/env node

/**
 * Extension E2E tests — tests pi-council loaded as a pi extension.
 *
 * Uses createMock to spin up a real pi instance with the extension,
 * then simulates Claude/Codex calling spawn_council, council_status,
 * read_stream, council_followup, and cancel_council.
 *
 * In pi-mock, the extension runs in INTERACTIVE mode (ctx.hasUI = true):
 *   - spawn_council returns immediately with "Council spawned..."
 *   - Per-member results arrive as steer followUps (triggerTurn: false)
 *   - Combined summary triggers a new turn (triggerTurn: true)
 *
 * The controllable brain handles requests from both the orchestrator pi
 * and the council member pi processes (all routed through the mock gateway).
 *
 * Zero real API calls. Fully sandboxed.
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import {
  createMock,
  createControllableBrain,
  text,
  toolCall,
} from "pi-mock";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, "../dist/extensions/pi-council/index.js");

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
    if (process.env.DEBUG) console.error(err.stack);
  }
}

// ─── Test config ─────────────────────────────────────────────────────

function writeTestConfig(homeDir, models) {
  const configDir = path.join(homeDir, ".pi-council");
  fs.mkdirSync(configDir, { recursive: true });

  const modelList = models ?? [
    { id: "claude", provider: "anthropic", model: "mock-claude" },
    { id: "gpt", provider: "openai", model: "mock-gpt" },
  ];

  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      models: Object.fromEntries(modelList.map((m) => [m.id, { provider: m.provider, model: m.model }])),
      profiles: {
        default: { models: modelList.map((m) => m.id) },
      },
      defaultProfile: "default",
    }, null, 2),
  );
}

/** Wait for artifacts to be written (poll-based). */
async function waitForArtifact(filePath, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/** Extract all user messages from a request as a combined string for assertions. */
function getConversationText(request) {
  const msgs = request.messages ?? [];
  return msgs
    .filter(m => m.role === "user")
    .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content))
    .join("\n");
}

/** Poll until condition returns truthy, then return it. */
async function waitForCondition(fn, timeoutMs = 5000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

process.stdout.write("\n🧪 Extension E2E Test Suite\n\n");

// ═══════════════════════════════════════════════════════════════════════
// E2E: spawn_council — full lifecycle
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("── spawn_council ──\n");

await test("E2E1: spawn_council → members respond → results delivered", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Get council perspectives on testing.");

    // Turn 1: orchestrator calls spawn_council
    const orchCall1 = await cb.waitForCall({ model: "mock" }, 10000);
    orchCall1.respond(
      toolCall("spawn_council", {
        question: "What are best practices for E2E testing?",
      }),
    );

    // spawn_council returns immediately (interactive) + members start calling brain
    const [orch2, claudeCall, gptCall] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
      cb.waitForCall({ model: "mock-gpt" }, 15000),
    ]);

    // Verify interactive mode: tool result says "Council spawned"
    const toolResult = getConversationText(orch2.request);
    assert(toolResult.includes("Council spawned"), "interactive mode: immediate return");

    // End turn 1
    orch2.respond(text("Council is running, waiting for results."));

    // Members respond → triggers followUps → turn 2
    claudeCall.respond(text("Claude: Focus on user flows and avoid testing implementation details."));
    gptCall.respond(text("GPT: Prioritize critical paths and use realistic test data."));

    // Turn 2: triggered by council_complete followUp
    const orchCall3 = await cb.waitForCall({ model: "mock" }, 20000);
    const turn2Text = getConversationText(orchCall3.request);
    assert(turn2Text.includes("council members responded"), "summary delivered");
    assert(turn2Text.includes("CLAUDE") || turn2Text.includes("Claude"), "has claude result");
    assert(turn2Text.includes("GPT") || turn2Text.includes("Gpt"), "has gpt result");

    orchCall3.respond(text("Synthesis: Focus on user flows with realistic data."));

    // Wait for artifacts
    const runsDir = path.join(testHome, ".pi-council", "runs");
    await new Promise(r => setTimeout(r, 1500));

    assert(fs.existsSync(runsDir), "runs directory exists");
    const runs = fs.readdirSync(runsDir);
    assert(runs.length >= 1, `has runs: ${runs.length}`);

    const runDir = path.join(runsDir, runs[0]);
    assert(fs.existsSync(path.join(runDir, "results.json")), "results.json");
    assert(fs.existsSync(path.join(runDir, "results.md")), "results.md");
    assert(fs.existsSync(path.join(runDir, "claude.json")), "claude.json");
    assert(fs.existsSync(path.join(runDir, "gpt.json")), "gpt.json");

    const results = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf-8"));
    assert(results.members.length === 2, "2 members in results");
    assert(results.members.every(m => m.state === "done"), "all done");
    assert(results.members.every(m => m.output.length > 0), "all have output");
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

await test("E2E2: spawn_council with model filter spawns subset", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Quick review with claude only.");

    const orchCall1 = await cb.waitForCall({ model: "mock" }, 10000);
    orchCall1.respond(
      toolCall("spawn_council", {
        question: "Quick code review.",
        models: ["claude"],
      }),
    );

    // Only claude member + orchestrator turn
    const [orch2, claudeCall] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
    ]);

    orch2.respond(text("Single model review in progress."));
    claudeCall.respond(text("Claude: Code looks clean, minor naming suggestions."));

    // Verify no GPT call
    let gotGpt = false;
    try {
      await cb.waitForCall({ model: "mock-gpt" }, 2000);
      gotGpt = true;
    } catch { /* expected timeout */ }
    assert(!gotGpt, "GPT was not spawned");

    // Turn 2 from followUp
    const orchCall3 = await cb.waitForCall({ model: "mock" }, 20000);
    orchCall3.respond(text("Got it — code is clean."));

    await new Promise(r => setTimeout(r, 1500));

    const runsDir = path.join(testHome, ".pi-council", "runs");
    const runs = fs.readdirSync(runsDir);
    const runDir = path.join(runsDir, runs[runs.length - 1]);
    const results = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf-8"));
    assert(results.members.length === 1, `1 member, got ${results.members.length}`);
    assert(results.members[0].id === "claude", "only claude");
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// E2E: council_status
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── council_status ──\n");

await test("E2E3: council_status returns member info after completion", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome, [{ id: "claude", provider: "anthropic", model: "mock-claude" }]);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Spawn council then check status.");

    // Spawn council
    const orchCall1 = await cb.waitForCall({ model: "mock" }, 10000);
    orchCall1.respond(
      toolCall("spawn_council", {
        question: "Status test question.",
        models: ["claude"],
      }),
    );

    const [orch2, claudeCall] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
    ]);

    orch2.respond(text("Council spawned."));
    claudeCall.respond(text("Status test response from Claude."));

    // Turn 2: council results delivered. Now check status.
    const orchCall3 = await cb.waitForCall({ model: "mock" }, 20000);
    orchCall3.respond(toolCall("council_status", {}));

    // Turn continues: orchestrator sees status result
    const orchCall4 = await cb.waitForCall({ model: "mock" }, 10000);
    const statusResult = getConversationText(orchCall4.request);
    assert(statusResult.includes("claude"), "status mentions claude");
    assert(statusResult.includes("done"), "status shows done");

    orchCall4.respond(text("Status confirmed."));
    await new Promise(r => setTimeout(r, 1000));
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// E2E: read_stream
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── read_stream ──\n");

await test("E2E4: read_stream returns member output after completion", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome, [{ id: "claude", provider: "anthropic", model: "mock-claude" }]);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Spawn then read stream.");

    const orchCall1 = await cb.waitForCall({ model: "mock" }, 10000);
    orchCall1.respond(
      toolCall("spawn_council", {
        question: "Stream test.",
        models: ["claude"],
      }),
    );

    const [orch2, claudeCall] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
    ]);

    orch2.respond(text("Spawned."));
    claudeCall.respond(text("Detailed analysis from Claude member."));

    // Turn 2: after followUp, call read_stream
    const orchCall3 = await cb.waitForCall({ model: "mock" }, 20000);
    orchCall3.respond(toolCall("read_stream", { memberId: "claude" }));

    const orchCall4 = await cb.waitForCall({ model: "mock" }, 10000);
    const streamResult = getConversationText(orchCall4.request);
    assert(streamResult.includes("Detailed analysis"), "read_stream has member output");
    assert(streamResult.includes("CLAUDE"), "read_stream has member ID header");

    orchCall4.respond(text("Output received."));
    await new Promise(r => setTimeout(r, 1000));
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

await test("E2E5: read_stream for unknown member returns error", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome, [{ id: "claude", provider: "anthropic", model: "mock-claude" }]);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Read nonexistent stream.");

    // Spawn council first
    const orchCall1 = await cb.waitForCall({ model: "mock" }, 10000);
    orchCall1.respond(
      toolCall("spawn_council", {
        question: "Error test.",
        models: ["claude"],
      }),
    );

    const [orch2, claudeCall] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
    ]);

    orch2.respond(text("Spawned."));
    claudeCall.respond(text("Done."));

    // Turn 2: read nonexistent member
    const orchCall3 = await cb.waitForCall({ model: "mock" }, 20000);
    orchCall3.respond(toolCall("read_stream", { memberId: "nonexistent" }));

    const orchCall4 = await cb.waitForCall({ model: "mock" }, 10000);
    const result = getConversationText(orchCall4.request);
    assert(result.includes("Error") || result.includes("Unknown"), "error for unknown member");

    orchCall4.respond(text("Got error."));
    await new Promise(r => setTimeout(r, 1000));
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// E2E: cancel_council
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── cancel_council ──\n");

await test("E2E6: cancel_council on completed council returns gracefully", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome, [{ id: "claude", provider: "anthropic", model: "mock-claude" }]);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Spawn then cancel.");

    const orchCall1 = await cb.waitForCall({ model: "mock" }, 10000);
    orchCall1.respond(
      toolCall("spawn_council", {
        question: "Cancel test.",
        models: ["claude"],
      }),
    );

    const [orch2, claudeCall] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
    ]);

    orch2.respond(text("Spawned."));
    claudeCall.respond(text("Before cancel."));

    // Turn 2: cancel the completed council
    const orchCall3 = await cb.waitForCall({ model: "mock" }, 20000);
    orchCall3.respond(toolCall("cancel_council", {}));

    const orchCall4 = await cb.waitForCall({ model: "mock" }, 10000);
    const cancelResult = getConversationText(orchCall4.request);
    assert(
      cancelResult.includes("Cancel") || cancelResult.includes("cancel"),
      `cancel result: ${cancelResult.slice(-200)}`,
    );

    orchCall4.respond(text("Cancelled."));
    await new Promise(r => setTimeout(r, 1000));
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// E2E: council_followup
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── council_followup ──\n");

await test("E2E7: council_followup on completed council returns gracefully", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome, [{ id: "claude", provider: "anthropic", model: "mock-claude" }]);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Spawn then follow up.");

    const orchCall1 = await cb.waitForCall({ model: "mock" }, 10000);
    orchCall1.respond(
      toolCall("spawn_council", {
        question: "Follow-up test.",
        models: ["claude"],
      }),
    );

    const [orch2, claudeCall] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
    ]);

    orch2.respond(text("Spawned."));
    claudeCall.respond(text("Initial response."));

    // Turn 2: send followup after completion
    const orchCall3 = await cb.waitForCall({ model: "mock" }, 20000);
    orchCall3.respond(
      toolCall("council_followup", {
        type: "steer",
        message: "Also consider performance.",
      }),
    );

    const orchCall4 = await cb.waitForCall({ model: "mock" }, 10000);
    const followUpResult = getConversationText(orchCall4.request);
    assert(
      followUpResult.includes("steer") || followUpResult.includes("Sent"),
      `followup result: ${followUpResult.slice(-200)}`,
    );

    orchCall4.respond(text("Follow-up sent."));
    await new Promise(r => setTimeout(r, 1000));
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// E2E: No council — tools return gracefully
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Error handling ──\n");

await test("E2E8: council_status with no council returns gracefully", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Check status of nothing.");

    const orchCall1 = await cb.waitForCall({ model: "mock" }, 10000);
    orchCall1.respond(toolCall("council_status", {}));

    const orchCall2 = await cb.waitForCall({ model: "mock" }, 10000);
    const result = getConversationText(orchCall2.request);
    assert(result.includes("No active council"), "no council message");

    orchCall2.respond(text("No council found."));
    await mock.drain(15000);
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

await test("E2E9: cancel_council with no council returns gracefully", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Cancel nothing.");

    const orchCall1 = await cb.waitForCall({ model: "mock" }, 10000);
    orchCall1.respond(toolCall("cancel_council", {}));

    const orchCall2 = await cb.waitForCall({ model: "mock" }, 10000);
    const result = getConversationText(orchCall2.request);
    assert(result.includes("No active council"), "no council message");

    orchCall2.respond(text("Nothing to cancel."));
    await mock.drain(15000);
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

await test("E2E10: read_stream with no council returns gracefully", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Read nothing.");

    const orchCall1 = await cb.waitForCall({ model: "mock" }, 10000);
    orchCall1.respond(toolCall("read_stream", { memberId: "claude" }));

    const orchCall2 = await cb.waitForCall({ model: "mock" }, 10000);
    const result = getConversationText(orchCall2.request);
    assert(result.includes("No active council"), "no council message");

    orchCall2.respond(text("No council."));
    await mock.drain(15000);
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

await test("E2E11: council_followup with no council returns gracefully", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Follow up nothing.");

    const orchCall1 = await cb.waitForCall({ model: "mock" }, 10000);
    orchCall1.respond(
      toolCall("council_followup", { type: "steer", message: "test" }),
    );

    const orchCall2 = await cb.waitForCall({ model: "mock" }, 10000);
    const result = getConversationText(orchCall2.request);
    assert(result.includes("No active council"), "no council message");

    orchCall2.respond(text("No council."));
    await mock.drain(15000);
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// E2E: Sequential councils
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Sequential councils ──\n");

await test("E2E12: Two sequential councils produce separate results", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    // --- First council ---
    await mock.prompt("First question.");

    const orchCall1 = await cb.waitForCall({ model: "mock" }, 10000);
    orchCall1.respond(
      toolCall("spawn_council", {
        question: "First council question.",
        models: ["claude"],
      }),
    );

    const [orch2, claude1] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
    ]);

    orch2.respond(text("First council running."));
    claude1.respond(text("First council Claude response."));

    // Turn 2
    const orchCall3 = await cb.waitForCall({ model: "mock" }, 20000);
    orchCall3.respond(text("First council done."));
    await new Promise(r => setTimeout(r, 1000));

    // --- Second council ---
    await mock.prompt("Second question.");

    const orchCall4 = await cb.waitForCall({ model: "mock" }, 10000);
    orchCall4.respond(
      toolCall("spawn_council", {
        question: "Second council question.",
        models: ["gpt"],
      }),
    );

    const [orch5, gpt1] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-gpt" }, 15000),
    ]);

    orch5.respond(text("Second council running."));
    gpt1.respond(text("Second council GPT response."));

    const orchCall6 = await cb.waitForCall({ model: "mock" }, 20000);
    orchCall6.respond(text("Second council done."));
    await new Promise(r => setTimeout(r, 1500));

    // Verify two separate runs
    const runsDir = path.join(testHome, ".pi-council", "runs");
    const runs = fs.readdirSync(runsDir).sort();
    assert(runs.length >= 2, `at least 2 runs: ${runs.length}`);

    const run1 = JSON.parse(fs.readFileSync(path.join(runsDir, runs[0], "results.json"), "utf-8"));
    const run2 = JSON.parse(fs.readFileSync(path.join(runsDir, runs[1], "results.json"), "utf-8"));
    assert(run1.runId !== run2.runId, "different runIds");
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// E2E: Tool chaining — spawn then status then read_stream
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Tool chaining ──\n");

await test("E2E13: spawn → status → read_stream in sequence", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome, [{ id: "claude", provider: "anthropic", model: "mock-claude" }]);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Full tool chain test.");

    // Step 1: spawn
    const orchCall1 = await cb.waitForCall({ model: "mock" }, 10000);
    orchCall1.respond(
      toolCall("spawn_council", {
        question: "Chain test.",
        models: ["claude"],
      }),
    );

    const [orch2, claudeCall] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
    ]);

    orch2.respond(text("Spawned."));
    claudeCall.respond(text("Chain test response from Claude."));

    // Turn 2: check status
    const orchCall3 = await cb.waitForCall({ model: "mock" }, 20000);
    orchCall3.respond(toolCall("council_status", {}));

    const orchCall4 = await cb.waitForCall({ model: "mock" }, 10000);
    const statusText = getConversationText(orchCall4.request);
    assert(statusText.includes("done"), "status shows done");

    // Step 3: read_stream
    orchCall4.respond(toolCall("read_stream", { memberId: "claude" }));

    const orchCall5 = await cb.waitForCall({ model: "mock" }, 10000);
    const streamText = getConversationText(orchCall5.request);
    assert(streamText.includes("Chain test response"), "stream has member output");

    orchCall5.respond(text("All done."));
    await new Promise(r => setTimeout(r, 1000));
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// E2E: Concurrent council UI — widget shows all active councils
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write("\n── Concurrent council UI ──\n");

await test("E2E14: Three concurrent councils show as separate widget rows", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome, [
    { id: "claude", provider: "anthropic", model: "mock-claude" },
    { id: "gpt", provider: "openai", model: "mock-gpt" },
  ]);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Spawn three councils.");

    // Orchestrator spawns council 1
    const orch1 = await cb.waitForCall({ model: "mock" }, 10000);
    orch1.respond(
      toolCall("spawn_council", {
        question: "Council Alpha question",
        models: ["claude"],
        label: "alpha",
      }),
    );

    // Wait for council 1 to spawn its member + orchestrator to get result
    const [orch2, c1Claude] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
    ]);

    // Don't complete c1Claude yet — keep council 1 running
    // Orchestrator spawns council 2
    orch2.respond(
      toolCall("spawn_council", {
        question: "Council Beta question",
        models: ["claude"],
        label: "beta",
      }),
    );

    const [orch3, c2Claude] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
    ]);

    // Don't complete c2Claude yet — keep council 2 running
    // Orchestrator spawns council 3
    orch3.respond(
      toolCall("spawn_council", {
        question: "Council Gamma question",
        models: ["claude"],
        label: "gamma",
      }),
    );

    const [orch4, c3Claude] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
    ]);

    // All 3 councils are running now. Pause to let UI update.
    orch4.respond(text("All three councils spawned."));
    await new Promise(r => setTimeout(r, 1000));

    // --- Verify the widget shows all 3 councils as separate rows ---
    // The widget key should be "pi-council" with 3 lines
    const widgetUpdates = mock.widgets.filter(w => w.key === "pi-council" && w.lines);
    const latestWidget = widgetUpdates[widgetUpdates.length - 1];

    assert(latestWidget, "pi-council widget was set");
    assert(latestWidget.lines.length === 3, `widget has 3 rows, got ${latestWidget.lines.length}: ${JSON.stringify(latestWidget.lines)}`);
    assert(latestWidget.lines.some(l => l.includes("alpha")), "widget row for alpha");
    assert(latestWidget.lines.some(l => l.includes("beta")), "widget row for beta");
    assert(latestWidget.lines.some(l => l.includes("gamma")), "widget row for gamma");

    // Now complete all members
    c1Claude.respond(text("Alpha done."));
    c2Claude.respond(text("Beta done."));
    c3Claude.respond(text("Gamma done."));

    // Drain remaining turns from the followUps
    // Each council_complete triggers a followUp. We need to handle the turns.
    // Wait for the triggerTurn followUps
    const finalOrch = await cb.waitForCall({ model: "mock" }, 20000);
    finalOrch.respond(text("Done."));

    // There may be more turns from the other 2 councils completing
    try {
      const extra1 = await cb.waitForCall({ model: "mock" }, 5000);
      extra1.respond(text("Done."));
    } catch { /* may not get more turns */ }
    try {
      const extra2 = await cb.waitForCall({ model: "mock" }, 5000);
      extra2.respond(text("Done."));
    } catch { /* may not get more turns */ }

    await new Promise(r => setTimeout(r, 1000));

    // After all councils complete, widget should be cleared
    const finalWidgets = mock.widgets.filter(w => w.key === "pi-council");
    const lastWidget = finalWidgets[finalWidgets.length - 1];
    assert(
      !lastWidget.lines || lastWidget.lines.length === 0,
      `widget cleared after all complete, got: ${JSON.stringify(lastWidget.lines)}`,
    );
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

await test("E2E15: Concurrent councils use widget not just status for visibility", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome, [
    { id: "claude", provider: "anthropic", model: "mock-claude" },
  ]);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Spawn two councils.");

    // Spawn council 1
    const orch1 = await cb.waitForCall({ model: "mock" }, 10000);
    orch1.respond(
      toolCall("spawn_council", {
        question: "First concurrent",
        models: ["claude"],
        label: "first",
      }),
    );

    const [orch2, c1] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
    ]);

    // Spawn council 2 (keep council 1 running)
    orch2.respond(
      toolCall("spawn_council", {
        question: "Second concurrent",
        models: ["claude"],
        label: "second",
      }),
    );

    const [orch3, c2] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
    ]);

    orch3.respond(text("Both spawned."));

    // Verify: widget is used (not just status)
    const latest = await waitForCondition(() => {
      const widgetUpdates = mock.widgets.filter(w => w.key === "pi-council" && w.lines);
      return widgetUpdates[widgetUpdates.length - 1];
    });
    assert(latest.lines.length === 2, `2 rows in widget, got ${latest.lines.length}`);

    // Complete council 1 — widget should update to 1 row
    c1.respond(text("First done."));

    // After first completes, widget should show only the second
    const afterFirst = await waitForCondition(() => {
      const matches = mock.widgets.filter(
        w => w.key === "pi-council" && w.lines && w.lines.length === 1 && w.lines[0].includes("second"),
      );
      return matches[matches.length - 1];
    }, 5000);
    assert(afterFirst.lines[0].includes("second"), "remaining row is second council");

    // Drain the turn triggered by first council completing
    const turn = await cb.waitForCall({ model: "mock" }, 20000);
    turn.respond(text("Got first result."));

    // Complete council 2
    c2.respond(text("Second done."));

    const turn2 = await cb.waitForCall({ model: "mock" }, 20000);
    turn2.respond(text("Got second result."));

    // Widget should be cleared
    const last = await waitForCondition(() => {
      const finalWidgets = mock.widgets.filter(w => w.key === "pi-council");
      const latestWidget = finalWidgets[finalWidgets.length - 1];
      return latestWidget && !latestWidget.lines ? latestWidget : null;
    }, 5000);
    assert(!last.lines, "widget cleared after all done");
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

await test("E2E16: Invalid model spawn does not create zombie active council or widget row", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome, [
    { id: "claude", provider: "anthropic", model: "mock-claude" },
  ]);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Try bad spawn then good spawn.");

    // First spawn fails validation before any council members are created.
    const orch1 = await cb.waitForCall({ model: "mock" }, 10000);
    orch1.respond(
      toolCall("spawn_council", {
        question: "Bad council",
        models: ["not-a-real-model"],
        label: "bad",
      }),
    );

    const orch2 = await cb.waitForCall({ model: "mock" }, 10000);
    const badSpawnText = getConversationText(orch2.request);
    assert(badSpawnText.includes("No matching models found"), `bad spawn returned validation error: ${badSpawnText}`);
    assert(mock.widgets.filter(w => w.key === "pi-council" && w.lines).length === 0, "no widget row created for invalid spawn");

    // Ask council_status immediately after bad spawn; it should not see a phantom active council.
    orch2.respond(toolCall("council_status", {}));
    const orch3 = await cb.waitForCall({ model: "mock" }, 10000);
    const statusAfterBad = getConversationText(orch3.request);
    assert(statusAfterBad.includes("No active council"), `no zombie active council after invalid spawn: ${statusAfterBad}`);

    // Now spawn a valid council and verify the widget only shows that one.
    orch3.respond(
      toolCall("spawn_council", {
        question: "Good council",
        models: ["claude"],
        label: "good",
      }),
    );

    const [orch4, claudeCall] = await Promise.all([
      cb.waitForCall({ model: "mock" }, 15000),
      cb.waitForCall({ model: "mock-claude" }, 15000),
    ]);

    orch4.respond(text("Valid council spawned."));

    const latest = await waitForCondition(() => {
      const widgets = mock.widgets.filter(w => w.key === "pi-council" && w.lines);
      return widgets[widgets.length - 1];
    }, 5000);
    assert(latest.lines.length === 1, `only one widget row for valid council, got ${latest.lines.length}`);
    assert(latest.lines[0].includes("good"), `row is the valid council: ${JSON.stringify(latest.lines)}`);
    assert(!latest.lines[0].includes("bad"), `invalid council did not leak into widget: ${JSON.stringify(latest.lines)}`);

    claudeCall.respond(text("Good council done."));
    const orch5 = await cb.waitForCall({ model: "mock" }, 20000);
    orch5.respond(text("All done."));
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

await test("E2E17: Invalid profile spawn does not create zombie active council or widget row", async () => {
  const cb = createControllableBrain();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ext-"));
  writeTestConfig(testHome, [
    { id: "claude", provider: "anthropic", model: "mock-claude" },
  ]);

  const mock = await createMock({
    brain: cb.brain,
    extensions: [EXTENSION_PATH],
    env: { HOME: testHome },
  });

  try {
    await mock.prompt("Try bad profile then check cleanup.");

    const orch1 = await cb.waitForCall({ model: "mock" }, 10000);
    orch1.respond(
      toolCall("spawn_council", {
        question: "Broken profile council",
        profile: "missing-profile",
        label: "broken-profile",
      }),
    );

    const orch2 = await cb.waitForCall({ model: "mock" }, 10000);
    const badProfileText = getConversationText(orch2.request);
    assert(badProfileText.toLowerCase().includes("profile"), `bad profile returned error: ${badProfileText}`);
    assert(mock.widgets.filter(w => w.key === "pi-council" && w.lines).length === 0, "no widget row created for invalid profile");

    orch2.respond(toolCall("council_status", {}));
    const orch3 = await cb.waitForCall({ model: "mock" }, 10000);
    const statusAfterBad = getConversationText(orch3.request);
    assert(statusAfterBad.includes("No active council"), `no zombie active council after invalid profile: ${statusAfterBad}`);

    orch3.respond(text("Cleanup confirmed."));
  } finally {
    await mock.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

process.stdout.write(`\n📊 Extension E2E: ${passed} passed, ${failed} failed out of ${passed + failed}\n\n`);

process.stdout.write(`METRIC ext_e2e_passed=${passed}\n`);
process.stdout.write(`METRIC ext_e2e_failed=${failed}\n`);

process.exit(failed > 0 ? 1 : 0);
