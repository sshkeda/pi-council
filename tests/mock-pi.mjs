#!/usr/bin/env node

/**
 * Mock pi binary that speaks the RPC protocol.
 *
 * Simulates a pi agent:
 * - Accepts "prompt" commands
 * - Emits agent_start, message_update (text_delta), agent_end events
 * - Supports "steer", "follow_up", "abort", "get_state" commands
 * - Responds with deterministic output based on provider/model
 *
 * Behavior can be controlled via env vars:
 *   MOCK_PI_DELAY_MS    — delay before responding (default: 50)
 *   MOCK_PI_FAIL        — if "true", simulate a crash
 *   MOCK_PI_OUTPUT      — override the response text
 *   MOCK_PI_TOOL_CALLS  — if "true", simulate tool usage
 */

import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const mode = getArg("--mode");
const provider = getArg("--provider") ?? "mock";
const model = getArg("--model") ?? "mock-model";
const delayMs = parseInt(process.env.MOCK_PI_DELAY_MS ?? "50", 10);
const shouldFail = process.env.MOCK_PI_FAIL === "true";

if (mode !== "rpc") {
  process.stderr.write("mock-pi only supports --mode rpc\n");
  process.exit(1);
}

function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let isStreaming = false;
let promptQueue = [];
let steerQueue = [];
let followUpQueue = [];

// Generate a response based on provider/model
function generateResponse(prompt) {
  if (process.env.MOCK_PI_OUTPUT) return process.env.MOCK_PI_OUTPUT;

  const responses = {
    claude: `As Claude, I'll analyze this independently.\n\nRegarding: "${prompt.slice(0, 80)}"\n\nMy assessment is that this requires careful consideration of multiple factors. I'd recommend a structured approach focusing on the core constraints first.`,
    gpt: `Looking at this from a systematic perspective.\n\nQuestion: "${prompt.slice(0, 80)}"\n\nI've analyzed the key dimensions and my conclusion differs slightly from what you might expect. The critical factor here is often overlooked.`,
    gemini: `I'll research this thoroughly.\n\nAnalyzing: "${prompt.slice(0, 80)}"\n\nBased on my analysis, there are three key considerations. The data suggests a different approach than conventional wisdom.`,
    grok: `Let me give you a direct take.\n\nOn: "${prompt.slice(0, 80)}"\n\nHere's what I think most people get wrong about this. The real issue isn't what's being discussed — it's the underlying assumption.`,
  };

  // Try to match provider to a response style
  for (const [key, text] of Object.entries(responses)) {
    if (provider.includes(key) || model.includes(key)) {
      return text;
    }
  }

  return `Mock response from ${provider}/${model} for: "${prompt.slice(0, 80)}"`;
}

async function processPrompt(prompt, requestId) {
  if (shouldFail) {
    process.stderr.write("Mock pi simulated crash\n");
    process.exit(1);
  }

  isStreaming = true;

  // Send response to the prompt command
  send({ type: "response", id: requestId, command: "prompt", success: true });

  // Emit agent_start
  send({ type: "agent_start" });
  send({ type: "turn_start" });

  // Simulate tool usage if requested
  if (process.env.MOCK_PI_TOOL_CALLS === "true") {
    send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "." } });
    await delay(delayMs);
    send({
      type: "tool_execution_end", toolCallId: "call_1", toolName: "read",
      result: { content: [{ type: "text", text: "file1.ts\nfile2.ts" }], details: {} },
      isError: false,
    });

    // Check for steer messages between tool calls
    while (steerQueue.length > 0) {
      const steer = steerQueue.shift();
      // Process steer by modifying our response
      prompt = prompt + "\n[STEER]: " + steer.message;
    }
  }

  await delay(delayMs);

  // Generate response
  const responseText = generateResponse(prompt);
  const words = responseText.split(" ");

  // Stream text deltas
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    model,
    provider,
    stopReason: "stop",
  };

  send({ type: "message_start", message });

  for (const word of words) {
    const delta = (message.content[0].text ? " " : "") + word;
    message.content[0].text += delta;
    send({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
    });
    await delay(5); // Small delay between words
  }

  send({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "done", reason: "stop", message },
  });

  send({ type: "message_end", message });
  send({ type: "turn_end", message, toolResults: [] });
  send({ type: "agent_end", messages: [message] });

  isStreaming = false;

  // Process follow-ups
  if (followUpQueue.length > 0) {
    const fu = followUpQueue.shift();
    await processPrompt(fu.message, fu.requestId);
  }
}

// Read stdin line by line
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  try {
    const cmd = JSON.parse(line.trim());

    switch (cmd.type) {
      case "prompt":
        if (isStreaming && !cmd.streamingBehavior) {
          send({ type: "response", id: cmd.id, command: "prompt", success: false, error: "Agent is streaming. Specify streamingBehavior." });
        } else if (isStreaming && cmd.streamingBehavior === "steer") {
          steerQueue.push({ message: cmd.message, requestId: cmd.id });
          send({ type: "response", id: cmd.id, command: "prompt", success: true });
        } else if (isStreaming && cmd.streamingBehavior === "followUp") {
          followUpQueue.push({ message: cmd.message, requestId: cmd.id });
          send({ type: "response", id: cmd.id, command: "prompt", success: true });
        } else {
          await processPrompt(cmd.message, cmd.id);
        }
        break;

      case "steer":
        if (!isStreaming) {
          send({ type: "response", id: cmd.id, command: "steer", success: false, error: "Agent is not streaming." });
        } else {
          steerQueue.push({ message: cmd.message, requestId: cmd.id });
          send({ type: "response", id: cmd.id, command: "steer", success: true });
        }
        break;

      case "follow_up":
        followUpQueue.push({ message: cmd.message, requestId: cmd.id });
        send({ type: "response", id: cmd.id, command: "follow_up", success: true });
        break;

      case "abort":
        isStreaming = false;
        steerQueue = [];
        send({ type: "response", id: cmd.id, command: "abort", success: true });
        break;

      case "get_state":
        send({
          type: "response", id: cmd.id, command: "get_state", success: true,
          data: { model: { id: model, provider }, isStreaming, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" },
        });
        break;

      case "get_session_stats":
        send({
          type: "response", id: cmd.id, command: "get_session_stats", success: true,
          data: { tokens: { input: 100, output: 200, total: 300 }, cost: 0.01 },
        });
        break;

      default:
        send({ type: "response", id: cmd.id, command: cmd.type, success: false, error: `Unknown command: ${cmd.type}` });
    }
  } catch (err) {
    // Ignore unparseable input
  }
});

rl.on("close", () => {
  process.exit(0);
});
