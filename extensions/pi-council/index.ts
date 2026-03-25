/**
 * pi-council extension — registers spawn_council tool.
 * Imports all logic from shared core — zero duplication.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// Shared core — single source of truth
import { loadConfig, resolveModels, getRunsDir, type ModelSpec } from "../../src/core/config.js";
import { spawnWorker, agentPaths } from "../../src/core/runner.js";
import { parseStream } from "../../src/core/stream-parser.js";
import { generateRunId } from "../../src/util/run-id.js";
import type { RunMeta } from "../../src/core/run-state.js";

interface AgentResult {
  id: string;
  model: string;
  output: string;
  exitCode: number | null;
  finished: boolean;
}

export default function (pi: ExtensionAPI) {
  // Track active councils so we can cancel them
  const activeRuns = new Map<string, { children: import("node:child_process").ChildProcess[]; runDir: string }>();

  pi.registerTool({
    name: "cancel_council",
    label: "Cancel Council",
    description: "Cancel a running council by run ID, or cancel the most recent one.",
    promptSnippet: "Cancel a running council.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "Run ID to cancel. Omit to cancel the most recent." })),
    }),
    async execute(_toolCallId, params) {
      let targetId = params.runId;

      if (!targetId) {
        // Cancel most recent
        const keys = [...activeRuns.keys()];
        if (keys.length === 0) {
          return { content: [{ type: "text", text: "No active councils to cancel." }], details: {} };
        }
        targetId = keys[keys.length - 1];
      }

      const run = activeRuns.get(targetId);
      if (!run) {
        return { content: [{ type: "text", text: `No active council with ID: ${targetId}` }], details: {} };
      }

      for (const child of run.children) {
        try { child.kill("SIGTERM"); } catch {}
      }
      activeRuns.delete(targetId);

      return {
        content: [{ type: "text", text: `Cancelled council: ${targetId}` }],
        details: {},
      };
    },
  });

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
      const isInteractive = ctx.hasUI;
      const config = loadConfig();

      let models: ModelSpec[];
      try {
        models = resolveModels(config, params.models);
      } catch {
        models = [];
      }

      if (models.length === 0) {
        return {
          content: [{ type: "text", text: "No valid models selected." }],
          details: {},
        };
      }

      const runId = generateRunId();
      const runDir = path.join(getRunsDir(), runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "prompt.txt"), params.question);

      const meta: RunMeta = {
        runId,
        prompt: params.question,
        startedAt: Date.now(),
        agents: models,
        cwd: ctx.cwd,
      };
      fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta, null, 2));

      const results: AgentResult[] = models.map((m) => ({
        id: m.id,
        model: m.model,
        output: "",
        exitCode: null,
        finished: false,
      }));

      let finishedCount = 0;
      const children: import("node:child_process").ChildProcess[] = [];
      activeRuns.set(runId, { children, runDir });

      function buildSummary(): string {
        return results
          .map((r) => {
            const icon = r.exitCode === 0 ? "✅" : "❌";
            return `## ${icon} ${r.id.toUpperCase()} (${r.model})\n\n${r.output || "(no output)"}`;
          })
          .join("\n\n---\n\n");
      }

      function writeArtifacts(summary: string): void {
        try {
          fs.writeFileSync(path.join(runDir, "results.md"), `# Council Results\n\n${summary}`);
          fs.writeFileSync(
            path.join(runDir, "results.json"),
            JSON.stringify({
              runId,
              prompt: params.question,
              completedAt: Date.now(),
              workers: results.map((r) => ({
                id: r.id,
                model: r.model,
                status: r.exitCode === 0 ? "done" : "failed",
                finalText: r.output,
                exitCode: r.exitCode,
              })),
            }, null, 2),
          );
        } catch {}
      }

      function deliverResults(): void {
        activeRuns.delete(runId);
        const summary = buildSummary();
        writeArtifacts(summary);
        pi.sendMessage(
          {
            customType: "council-result",
            content: `🏛️ Council results for: "${params.question}"\n\n${summary}`,
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      }

      for (let i = 0; i < models.length; i++) {
        const m = models[i];

        // Use shared spawnWorker — detach=false so close events fire in-process
        const { child } = spawnWorker(runDir, m, params.question, config, ctx.cwd, false);
        children.push(child);

        child.on("error", (err) => {
          results[i].exitCode = 1;
          results[i].finished = true;
          results[i].output = `spawn error: ${err.message}`;
          try { fs.writeFileSync(agentPaths(runDir, m.id).done, "1"); } catch {}
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

          const paths = agentPaths(runDir, m.id);
          const parsed = parseStream(paths.stream);
          r.output = parsed.finalText || parsed.assistantText;

          try { fs.writeFileSync(paths.done, String(code ?? "")); } catch {}

          finishedCount++;
          ctx.ui.setStatus("council", `🏛️ Council: ${finishedCount}/${models.length} done`);

          if (finishedCount === models.length) {
            ctx.ui.setStatus("council", undefined);
            deliverResults();
          }
        });
      }

      const modelNames = models.map((m) => m.id).join(", ");

      // Non-interactive: block until done
      if (!isInteractive) {
        await new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if (finishedCount === models.length) {
              clearInterval(interval);
              resolve();
            }
          }, 500);
        });

        const summary = buildSummary();
        writeArtifacts(summary);
        return {
          content: [{ type: "text", text: `🏛️ Council results:\n\n${summary}` }],
          details: { runId, models: modelNames },
        };
      }

      // Interactive: return immediately, results arrive via followUp
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
