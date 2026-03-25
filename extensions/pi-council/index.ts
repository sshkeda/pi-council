/**
 * pi-council extension — registers a spawn_council tool that:
 * 1. Spawns different AI models as separate pi processes
 * 2. Returns immediately so the LLM keeps working
 * 3. Auto-notifies via followUp when all agents finish
 *
 * Zero polling. The Node event loop watches child processes.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

interface ModelDef {
  id: string;
  provider: string;
  model: string;
}

const DEFAULT_MODELS: ModelDef[] = [
  { id: "claude", provider: "anthropic", model: "claude-opus-4-6" },
  { id: "gpt", provider: "openai-codex", model: "gpt-5.4" },
  { id: "gemini", provider: "google", model: "gemini-3.1-pro-preview" },
  { id: "grok", provider: "xai", model: "grok-4.20-0309-reasoning" },
];

const SYSTEM_PROMPT = `You are one member of a multi-model council.
Work independently. Do your own research using your tools.
Do NOT spawn other agents, run council commands, or coordinate with other models.
Be concise and specific.`;

const COUNCIL_DIR = path.join(os.homedir(), ".pi-council", "runs");

interface AgentResult {
  id: string;
  model: string;
  output: string;
  exitCode: number | null;
  finished: boolean;
}

function generateRunId(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const t = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const hex = crypto.randomBytes(2).toString("hex");
  return `${d}-${t}-${hex}`;
}

function parseJsonlFinalText(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  let finalText = "";
  let assistantText = "";
  try {
    for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const texts: string[] = [];
        for (const part of event.message.content ?? []) {
          if (part.type === "text") texts.push(part.text ?? "");
        }
        const joined = texts.join("").trim();
        if (joined) finalText = joined;
      } else if (event.type === "message_update" && event.message?.role === "assistant") {
        const texts: string[] = [];
        for (const part of event.message.content ?? []) {
          if (part.type === "text") texts.push(part.text ?? "");
        }
        const joined = texts.join("").trim();
        if (joined) assistantText = joined;
      }
    }
  } catch { /* ignore */ }
  return finalText || assistantText;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "spawn_council",
    label: "Spawn Council",
    description:
      "Spawn multiple AI models (Claude, GPT, Gemini, Grok) in parallel to get independent opinions. " +
      "Returns immediately — continue working. Results are auto-delivered when all agents finish.",
    promptSnippet:
      "Spawn 4 AI models for independent opinions. Returns immediately; results auto-delivered via followUp.",
    promptGuidelines: [
      "Use spawn_council when you need diverse perspectives on a question — architecture decisions, code review, investment analysis, or any high-stakes judgment call.",
      "After calling spawn_council, continue your foreground work. Results arrive automatically as a followUp message.",
      "Each model is a separate pi instance with its own tools. They do their own research independently.",
      "The point is surfacing disagreement, not consensus. Pay attention to the dissenter.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "Question for the council" }),
      models: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Model IDs to use (default: all 4). e.g. ["claude", "grok"]',
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // In non-interactive mode (print mode), fall back to blocking behavior
      // because pi exits immediately after the tool returns
      const isInteractive = ctx.hasUI;
      const selectedIds = params.models?.map((s) => s.toLowerCase()) ?? null;
      const models = selectedIds
        ? DEFAULT_MODELS.filter((m) => selectedIds.includes(m.id))
        : DEFAULT_MODELS;

      if (models.length === 0) {
        return {
          content: [{ type: "text", text: "No valid models selected." }],
          details: {},
        };
      }

      const runId = generateRunId();
      const runDir = path.join(COUNCIL_DIR, runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "prompt.txt"), params.question);
      fs.writeFileSync(
        path.join(runDir, "meta.json"),
        JSON.stringify({ runId, prompt: params.question, startedAt: Date.now(), agents: models }, null, 2),
      );

      const results: AgentResult[] = models.map((m) => ({
        id: m.id,
        model: m.model,
        output: "",
        exitCode: null,
        finished: false,
      }));

      let finishedCount = 0;

      function deliverResults() {
        const summary = results
          .map((r) => {
            const icon = r.exitCode === 0 ? "✅" : "❌";
            return `## ${icon} ${r.id.toUpperCase()} (${r.model})\n\n${r.output || "(no output)"}`;
          })
          .join("\n\n---\n\n");

        try {
          fs.writeFileSync(path.join(runDir, "results.md"), `# Council Results\n\n${summary}`);
          fs.writeFileSync(
            path.join(runDir, "results.json"),
            JSON.stringify({ runId, results: results.map((r) => ({ id: r.id, model: r.model, output: r.output, exitCode: r.exitCode })) }, null, 2),
          );
        } catch {}

        pi.sendMessage(
          {
            customType: "council-result",
            content: `🏛️ Council results for: "${params.question}"\n\n${summary}`,
            display: true,
          },
          {
            deliverAs: "followUp",
            triggerTurn: true,
          },
        );
      }

      for (let i = 0; i < models.length; i++) {
        const m = models[i];
        const streamPath = path.join(runDir, `${m.id}.jsonl`);
        const errPath = path.join(runDir, `${m.id}.err`);
        const streamFd = fs.openSync(streamPath, "w");
        const errFd = fs.openSync(errPath, "w");

        const child = spawn(
          "pi",
          [
            "--mode", "json",
            "-p",
            "--provider", m.provider,
            "--model", m.model,
            "--tools", "bash,read",
            "--no-session",
            "--append-system-prompt", SYSTEM_PROMPT,
            params.question,
          ],
          {
            stdio: ["ignore", streamFd, errFd],
            detached: false,
            cwd: ctx.cwd,
            env: { ...process.env },
          },
        );

        fs.closeSync(streamFd);
        fs.closeSync(errFd);
        // Don't unref — we need close handlers to fire inside pi's process

        const pidPath = path.join(runDir, `${m.id}.pid`);
        fs.writeFileSync(pidPath, String(child.pid ?? ""));

        child.on("error", (err) => {
          const r = results[i];
          r.exitCode = 1;
          r.finished = true;
          r.output = `spawn error: ${err.message}`;
          try { fs.writeFileSync(path.join(runDir, `${m.id}.done`), "1"); } catch {}
          finishedCount++;
          if (finishedCount === models.length) {
            ctx.ui.setStatus("council", undefined);
            deliverResults();
          }
        });

        child.on("close", (code) => {
          const r = results[i];
          r.exitCode = code;
          r.finished = true;
          r.output = parseJsonlFinalText(streamPath);

          try { fs.writeFileSync(path.join(runDir, `${m.id}.done`), String(code ?? "")); } catch {}

          finishedCount++;

          // Update status widget
          ctx.ui.setStatus(
            "council",
            `🏛️ Council: ${finishedCount}/${models.length} done`,
          );

          // All finished — push results to the LLM
          if (finishedCount === models.length) {
            ctx.ui.setStatus("council", undefined);
            deliverResults();
          }
        });
      }

      const modelNames = models.map((m) => m.id).join(", ");

      // In non-interactive mode, wait for all agents to finish before returning
      if (!isInteractive) {
        await new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if (finishedCount === models.length) {
              clearInterval(interval);
              resolve();
            }
          }, 500);
        });

        const summary = results
          .map((r) => {
            const icon = r.exitCode === 0 ? "✅" : "❌";
            return `## ${icon} ${r.id.toUpperCase()} (${r.model})\n\n${r.output || "(no output)"}`;
          })
          .join("\n\n---\n\n");

        return {
          content: [{ type: "text", text: `🏛️ Council results:\n\n${summary}` }],
          details: { runId, models: modelNames },
        };
      }

      // Interactive mode: return immediately, results arrive via followUp
      return {
        content: [
          {
            type: "text",
            text:
              `Council spawned: ${modelNames} (run: ${runId})\n` +
              `Results will be delivered automatically when all agents finish.\n` +
              `Continue with your other work.`,
          },
        ],
        details: { runId, models: modelNames },
      };
    },
  });
}
