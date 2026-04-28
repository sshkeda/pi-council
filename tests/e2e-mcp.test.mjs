#!/usr/bin/env node

/**
 * MCP E2E tests — validates the dedicated MCP server directly and through MCPorter.
 *
 * Coverage:
 *   1. Direct MCP stdio server lifecycle using the SDK client
 *   2. Cross-process persistence for completed runs (fresh server process reads disk artifacts)
 *   3. MCPorter keep-alive daemon behavior across separate CLI calls
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createGateway, createControllableBrain, text, toolCall } from "../../pi-mock/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, "../dist/src/mcp/server.js");
const MCPORTER_BIN = path.resolve(
  __dirname,
  "../node_modules/.bin",
  process.platform === "win32" ? "mcporter.cmd" : "mcporter",
);

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (error) {
    failed++;
    process.stdout.write(`  ❌ ${name}: ${error.message}\n`);
    if (process.env.DEBUG) console.error(error.stack);
  }
}

function createAgentDir(gatewayUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-mcp-agent-"));
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({
    providers: {
      "pi-mock": {
        baseUrl: `${gatewayUrl}/v1`,
        api: "anthropic-messages",
        apiKey: "k",
        models: [
          { id: "claude-mcp" },
          { id: "gpt-mcp" },
          { id: "mock" },
        ],
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dir, "settings.json"), "{}\n");
  return dir;
}

function writeCouncilConfig(homeDir) {
  const configDir = path.join(homeDir, ".pi-council");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    models: {
      claude: { provider: "pi-mock", model: "claude-mcp" },
      gpt: { provider: "pi-mock", model: "gpt-mcp" },
    },
    profiles: {
      default: {
        models: ["claude", "gpt"],
        systemPrompt: "You are one member of a multi-model council. Work independently.",
      },
    },
    defaultProfile: "default",
  }, null, 2));
}

async function createMcpClient(env) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_PATH],
    env,
    cwd: path.resolve(__dirname, ".."),
    stderr: "pipe",
  });

  let stderr = "";
  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
  }

  const client = new Client({ name: "pi-council-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  return {
    client,
    transport,
    getStderr: () => stderr,
    close: async () => {
      await client.close();
    },
  };
}

async function callToolJson(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const textBlock = result.content?.find((block) => block.type === "text");
  const payload = textBlock?.text ?? "";
  if (result.isError) {
    throw new Error(payload || `${name} failed`);
  }
  return payload ? JSON.parse(payload) : null;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? path.resolve(__dirname, ".."),
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs ?? 20_000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Command failed (${code})\nstdout: ${stdout}\nstderr: ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runMcporter(configPath, args, options = {}) {
  return await runCommand(MCPORTER_BIN, ["--config", configPath, ...args], options);
}

function parseJsonOutput(stdout) {
  return JSON.parse(stdout.trim());
}

process.stdout.write("\n🧪 MCP E2E Test Suite\n\n");

const gw = await createGateway({ brain: () => text("unused"), port: 0, default: "allow" });

await test("MCP1: direct SDK client can list tools, spawn a council, inspect live status, and wait for results", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-mcp-home-"));
  const agentDir = createAgentDir(gw.url);
  writeCouncilConfig(homeDir);

  const env = {
    ...process.env,
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  };

  const session = await createMcpClient(env);
  try {
    const listed = await session.client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    assert(toolNames.includes("spawn_council"), "spawn_council listed");
    assert(toolNames.includes("read_council_results"), "read_council_results listed");
    assert(toolNames.includes("cleanup_council_runs"), "cleanup_council_runs listed");

    const spawned = await callToolJson(session.client, "spawn_council", {
      question: "Say exactly hi",
      models: ["claude"],
    });
    assert(spawned.runId, "spawn returned runId");
    assert(spawned.models.length === 1, `spawned 1 model: ${JSON.stringify(spawned.models)}`);
    assert(spawned.models[0].id === "claude", "spawn used requested model");

    const memberCall = await cb.waitForCall({ model: "claude-mcp" }, 10_000);

    const liveStatus = await callToolJson(session.client, "council_status", { runId: spawned.runId });
    assert(liveStatus.source === "live", `status source: ${JSON.stringify(liveStatus)}`);
    assert(liveStatus.status.members.length === 1, "one live member");
    assert(["running", "spawning"].includes(liveStatus.status.members[0].state), `member live state: ${liveStatus.status.members[0].state}`);

    memberCall.respond(text("hi"));

    const results = await callToolJson(session.client, "read_council_results", {
      runId: spawned.runId,
      wait: true,
      timeoutMs: 30_000,
    });
    assert(results.source === "live", `results source: ${JSON.stringify(results)}`);
    assert(results.result.members[0].output === "hi", `result output: ${results.result.members[0].output}`);

    const stream = await callToolJson(session.client, "read_council_stream", {
      runId: spawned.runId,
      memberId: "claude",
    });
    assert(stream.status.output === "hi", `stream output: ${JSON.stringify(stream)}`);
  } finally {
    await session.close().catch(() => {});
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

await test("MCP2: completed runs remain readable from a fresh MCP server process", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-mcp-home-"));
  const agentDir = createAgentDir(gw.url);
  writeCouncilConfig(homeDir);

  const env = {
    ...process.env,
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  };

  let runId;
  {
    const session = await createMcpClient(env);
    try {
      const spawned = await callToolJson(session.client, "spawn_council", {
        question: "Persist this result",
        models: ["claude"],
      });
      runId = spawned.runId;

      const memberCall = await cb.waitForCall({ model: "claude-mcp" }, 10_000);
      memberCall.respond(text("persisted answer"));

      const results = await callToolJson(session.client, "read_council_results", {
        runId,
        wait: true,
        timeoutMs: 30_000,
      });
      assert(results.result.members[0].output === "persisted answer", "first process completed run");
    } finally {
      await session.close().catch(() => {});
    }
  }

  const freshSession = await createMcpClient(env);
  try {
    const status = await callToolJson(freshSession.client, "council_status", { runId });
    assert(status.source === "disk", `fresh status source: ${JSON.stringify(status)}`);
    assert(status.status === "complete", `fresh status value: ${JSON.stringify(status)}`);
    assert(status.results.members[0].output === "persisted answer", "disk status carries result");

    const stream = await callToolJson(freshSession.client, "read_council_stream", {
      runId,
      memberId: "claude",
    });
    assert(stream.source === "disk", `fresh stream source: ${JSON.stringify(stream)}`);
    assert(stream.status.output === "persisted answer", "disk stream output");

    const results = await callToolJson(freshSession.client, "read_council_results", { runId });
    assert(results.source === "disk", `fresh results source: ${JSON.stringify(results)}`);
    assert(results.result.members[0].output === "persisted answer", "fresh results output");

    const listed = await callToolJson(freshSession.client, "list_council_runs", {});
    assert(listed.runs.some((run) => run.runId === runId), "run appears in list_council_runs");
  } finally {
    await freshSession.close().catch(() => {});
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

await test("MCP4: council_followup steers a running council member", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-mcp-home-"));
  const agentDir = createAgentDir(gw.url);
  writeCouncilConfig(homeDir);

  const env = {
    ...process.env,
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  };

  const session = await createMcpClient(env);
  try {
    const spawned = await callToolJson(session.client, "spawn_council", {
      question: "Steer test",
      models: ["claude"],
    });
    assert(spawned.runId, "spawn returned runId");

    const memberCall = await cb.waitForCall({ model: "claude-mcp" }, 10_000);
    // Keep member busy with a tool call so steer can be delivered
    memberCall.respond(toolCall("bash", { command: "echo busy" }));

    const followupResult = await callToolJson(session.client, "council_followup", {
      runId: spawned.runId,
      message: "Please focus on testing",
      type: "steer",
    });
    assert(followupResult.delivered === true, `followup delivered: ${JSON.stringify(followupResult)}`);
    assert(followupResult.type === "steer", `followup type: ${followupResult.type}`);

    const steerCall = await cb.waitForCall({ model: "claude-mcp" }, 10_000);
    steerCall.respond(text("steered response"));

    // Drain extra turns from steer
    try { const extra = await cb.waitForCall({ model: "claude-mcp" }, 3000); extra.respond(text("done")); } catch {}

    const results = await callToolJson(session.client, "read_council_results", {
      runId: spawned.runId,
      wait: true,
      timeoutMs: 30_000,
    });
    assert(results.result.members[0].output.length > 0, `has output: ${results.result.members[0].output}`);
  } finally {
    await session.close().catch(() => {});
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

await test("MCP5: cancel_council cancels a running council", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-mcp-home-"));
  const agentDir = createAgentDir(gw.url);
  writeCouncilConfig(homeDir);

  const env = {
    ...process.env,
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  };

  const session = await createMcpClient(env);
  try {
    const spawned = await callToolJson(session.client, "spawn_council", {
      question: "Cancel test",
      models: ["claude", "gpt"],
    });
    assert(spawned.runId, "spawn returned runId");
    assert(spawned.models.length === 2, "2 models spawned");

    await cb.waitForCall({ model: "claude-mcp" }, 10_000);
    await cb.waitForCall({ model: "gpt-mcp" }, 10_000);

    const cancelResult = await callToolJson(session.client, "cancel_council", {
      runId: spawned.runId,
    });
    assert(cancelResult.runId === spawned.runId, `cancel runId: ${cancelResult.runId}`);
    assert(cancelResult.cancelled === "all-members", `cancelled: ${JSON.stringify(cancelResult.cancelled)}`);

    const results = await callToolJson(session.client, "read_council_results", {
      runId: spawned.runId,
      wait: true,
      timeoutMs: 30_000,
    });
    assert(results.result.members.every(m => m.state === "cancelled"), `all cancelled: ${JSON.stringify(results.result.members.map(m => m.state))}`);
  } finally {
    await session.close().catch(() => {});
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

await test("MCP6: cancel_council targets specific member", async () => {
  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-mcp-home-"));
  const agentDir = createAgentDir(gw.url);
  writeCouncilConfig(homeDir);

  const env = {
    ...process.env,
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  };

  const session = await createMcpClient(env);
  try {
    const spawned = await callToolJson(session.client, "spawn_council", {
      question: "Partial cancel test",
      models: ["claude", "gpt"],
    });

    const claudeCall = await cb.waitForCall({ model: "claude-mcp" }, 10_000);
    await cb.waitForCall({ model: "gpt-mcp" }, 10_000);

    const cancelResult = await callToolJson(session.client, "cancel_council", {
      runId: spawned.runId,
      memberIds: ["claude"],
    });
    assert(JSON.stringify(cancelResult.cancelled) === JSON.stringify(["claude"]), `cancelled claude only: ${JSON.stringify(cancelResult.cancelled)}`);

    const status = await callToolJson(session.client, "council_status", { runId: spawned.runId });
    const claudeMember = status.status.members.find(m => m.id === "claude");
    assert(claudeMember.state === "cancelled", `claude cancelled: ${claudeMember.state}`);

    const gptMember = status.status.members.find(m => m.id === "gpt");
    assert(["running", "spawning"].includes(gptMember.state), `gpt still running: ${gptMember.state}`);
  } finally {
    await session.close().catch(() => {});
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

await test("MCP7: council_followup on no live council returns error", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-mcp-home-"));
  const agentDir = createAgentDir(gw.url);
  writeCouncilConfig(homeDir);

  const env = {
    ...process.env,
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  };

  const session = await createMcpClient(env);
  try {
    let errored = false;
    try {
      await callToolJson(session.client, "council_followup", {
        message: "hello",
        type: "steer",
        runId: "nonexistent-run-id",
      });
    } catch (e) {
      errored = true;
      assert(e.message.includes("not active"), `error message: ${e.message}`);
    }
    assert(errored, "should error on nonexistent run");
  } finally {
    await session.close().catch(() => {});
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

await test("MCP3: MCPorter daemon keeps the MCP server alive across separate calls and survives restart via disk artifacts", async () => {
  assert(fs.existsSync(MCPORTER_BIN), `mcporter binary not found at ${MCPORTER_BIN}`);

  const cb = createControllableBrain();
  gw.setBrain(cb.brain);

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-mcporter-home-"));
  const agentDir = createAgentDir(gw.url);
  writeCouncilConfig(homeDir);

  const configPath = path.join(homeDir, "mcporter.json");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      "pi-council": {
        command: "node",
        args: [SERVER_PATH],
        env: {
          HOME: homeDir,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
        },
        lifecycle: "keep-alive",
      },
    },
    imports: [],
  }, null, 2));

  try {
    await runMcporter(configPath, ["daemon", "start"], { timeoutMs: 20_000 });

    const spawnOut = await runMcporter(configPath, [
      "call",
      "pi-council.spawn_council",
      "--output",
      "json",
      "--args",
      JSON.stringify({ question: "daemon hi", models: ["claude"] }),
    ], { timeoutMs: 30_000 });
    const spawned = parseJsonOutput(spawnOut.stdout);
    assert(spawned.runId, "mcporter spawn returned runId");

    const memberCall = await cb.waitForCall({ model: "claude-mcp" }, 10_000);

    const liveStatusOut = await runMcporter(configPath, [
      "call",
      "pi-council.council_status",
      "--output",
      "json",
      `runId=${spawned.runId}`,
    ], { timeoutMs: 20_000 });
    const liveStatus = parseJsonOutput(liveStatusOut.stdout);
    assert(liveStatus.source === "live", `daemon live status: ${JSON.stringify(liveStatus)}`);
    assert(["running", "spawning"].includes(liveStatus.status.members[0].state), `daemon member state: ${liveStatus.status.members[0].state}`);

    memberCall.respond(text("daemon hi"));

    const resultsOut = await runMcporter(configPath, [
      "call",
      "pi-council.read_council_results",
      "--output",
      "json",
      "--args",
      JSON.stringify({ runId: spawned.runId, wait: true, timeoutMs: 30_000 }),
    ], { timeoutMs: 40_000 });
    const results = parseJsonOutput(resultsOut.stdout);
    assert(results.result.members[0].output === "daemon hi", `daemon result: ${JSON.stringify(results)}`);

    const daemonStatus = await runMcporter(configPath, ["daemon", "status"], { timeoutMs: 20_000 });
    assert(daemonStatus.stdout.includes("pi-council"), `daemon status: ${daemonStatus.stdout}`);

    await runMcporter(configPath, ["daemon", "restart"], { timeoutMs: 20_000 });

    const diskStatusOut = await runMcporter(configPath, [
      "call",
      "pi-council.council_status",
      "--output",
      "json",
      `runId=${spawned.runId}`,
    ], { timeoutMs: 20_000 });
    const diskStatus = parseJsonOutput(diskStatusOut.stdout);
    assert(diskStatus.source === "disk", `post-restart status source: ${JSON.stringify(diskStatus)}`);
    assert(diskStatus.results.members[0].output === "daemon hi", "post-restart disk fallback works");
  } finally {
    await runMcporter(configPath, ["daemon", "stop"], { timeoutMs: 20_000 }).catch(() => {});
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

await gw.close();

process.stdout.write(`\n📊 MCP E2E: ${passed} passed, ${failed} failed out of ${passed + failed}\n\n`);
process.stdout.write(`METRIC mcp_e2e_passed=${passed}\n`);
process.stdout.write(`METRIC mcp_e2e_failed=${failed}\n`);

if (failed > 0) process.exit(1);
