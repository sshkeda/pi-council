/**
 * pi-council extension — registers spawn_council and cancel_council tools.
 *
 * Imports from shared core via relative paths. This is necessary during development
 * because TypeScript doesn't resolve self-referencing package exports. When installed
 * as an npm package, the exports field in package.json provides clean import paths
 * (e.g., "pi-council/core/config").
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// Shared core — single source of truth (relative paths required for TS dev, see module docstring)
import { loadConfig, resolveModels, type ModelSpec } from "../../src/core/config.js";
import { spawnWorker, agentPaths } from "../../src/core/runner.js";
import { parseStream } from "../../src/core/stream-parser.js";
import { createRun } from "../../src/core/run-lifecycle.js";

interface AgentResult {
  id: string;
  model: string;
  output: string;
  exitCode: number | null;
  finished: boolean;
}

export default function (pi: ExtensionAPI) {
  // Track active councils so we can cancel them.
  // Keyed by runId — entries are removed when the council completes or is cancelled.
  const activeRuns = new Map<string, { children: import("node:child_process").ChildProcess[]; runDir: string; cancelled: boolean }>();

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
        // Cancel most recent active council
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

      // Mark as cancelled BEFORE killing so handleFinish won't deliver results
      run.cancelled = true;
      for (const child of run.children) {
        try {
          child.kill("SIGTERM");
        } catch (err) {
          // ESRCH = process already exited — expected race condition, only log unexpected errors
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
            process.stderr.write(`⚠️  Failed to kill child: ${(err as Error).message}\n`);
          }
        }
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

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const isInteractive = ctx.hasUI;
      const config = loadConfig();

      let models: ModelSpec[];
      try {
        models = resolveModels(config, params.models);
      } catch (err) {
        // Surface the actual validation error (e.g., "Unknown model(s): xyz. Available: ...")
        return {
          content: [{ type: "text", text: (err as Error).message }],
          details: {},
        };
      }

      if (models.length === 0) {
        return {
          content: [{ type: "text", text: "No valid models selected." }],
          details: {},
        };
      }

      const { runId, runDir } = createRun(params.question, models, ctx.cwd);

      // Use config timeout (default 300s) — prevents agents from running forever
      const timeoutMs = config.timeout_seconds > 0 ? config.timeout_seconds * 1000 : 0;

      const results: AgentResult[] = models.map((m) => ({
        id: m.id,
        model: m.model,
        output: "",
        exitCode: null,
        finished: false,
      }));

      let finishedCount = 0;
      let delivered = false;
      const children: import("node:child_process").ChildProcess[] = [];
      const runState = { children, runDir, cancelled: false };
      activeRuns.set(runId, runState);

      function cleanup(): void {
        activeRuns.delete(runId);
        ctx.ui.setStatus("council", undefined);
      }

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
        } catch (err) {
          process.stderr.write(`⚠️  Failed to write council artifacts: ${(err as Error).message}\n`);
        }
      }

      function deliverResults(): void {
        if (delivered || !isInteractive || runState.cancelled) return;
        delivered = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        cleanup();
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

      // Handle AbortSignal — kill children and clean up when tool call is cancelled
      if (signal) {
        signal.addEventListener("abort", () => {
          runState.cancelled = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          for (const child of children) {
            try { child.kill("SIGTERM"); } catch { /* ESRCH: already exited */ }
          }
          cleanup();
        }, { once: true });
      }

      for (let i = 0; i < models.length; i++) {
        const m = models[i];

        let child: import("node:child_process").ChildProcess;
        try {
          const result = spawnWorker(runDir, m, params.question, config, ctx.cwd, false);
          child = result.child;
        } catch (err) {
          results[i].finished = true;
          results[i].exitCode = 1;
          results[i].output = `spawn error: ${(err as Error).message}`;
          finishedCount++;
          if (finishedCount === models.length) {
            cleanup();
            deliverResults();
          }
          continue;
        }
        children.push(child);

        const handleFinish = (code: number | null, error?: string) => {
          if (results[i].finished) return; // guard: error+close can both fire
          results[i].finished = true;
          results[i].exitCode = code;

          if (error) {
            results[i].output = error;
          } else {
            const paths = agentPaths(runDir, m.id);
            const parsed = parseStream(paths.stream);
            results[i].output = parsed.finalText || parsed.assistantText;
          }

          try {
            fs.writeFileSync(agentPaths(runDir, m.id).done, String(code ?? ""));
          } catch (err) {
            process.stderr.write(`⚠️  Failed to write .done for ${m.id}: ${(err as Error).message}\n`);
          }

          finishedCount++;

          // Don't update UI or deliver if cancelled
          if (runState.cancelled) return;

          ctx.ui.setStatus("council", `🏛️ Council: ${finishedCount}/${models.length} done`);

          if (finishedCount === models.length) {
            ctx.ui.setStatus("council", undefined);
            deliverResults();
          }
        };

        child.on("error", (err) => handleFinish(1, `spawn error: ${err.message}`));
        child.on("close", (code) => handleFinish(code, undefined));
      }

      // Enforce max timeout — kill stragglers so councils don't run forever
      let timeoutTimer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          if (runState.cancelled || finishedCount === models.length) return;
          runState.cancelled = true;
          for (const child of children) {
            try { child.kill("SIGTERM"); } catch { /* already exited */ }
          }
          // Mark unfinished agents
          for (let j = 0; j < models.length; j++) {
            if (!results[j].finished) {
              results[j].finished = true;
              results[j].exitCode = 124; // timeout exit code
              results[j].output = `(timed out after ${config.timeout_seconds}s)`;
              try { fs.writeFileSync(agentPaths(runDir, models[j].id).done, "124"); } catch {}
            }
          }
          cleanup();
          // Still deliver partial results
          delivered = true;
          const summary = buildSummary();
          writeArtifacts(summary);
          if (isInteractive) {
            pi.sendMessage(
              {
                customType: "council-result",
                content: `🏛️ Council results (⏰ timed out after ${config.timeout_seconds}s):\n\n${summary}`,
                display: true,
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          }
        }, timeoutMs);
        timeoutTimer.unref();
      }

      const modelNames = models.map((m) => m.id).join(", ");

      // Non-interactive: block until done
      if (!isInteractive) {
        await new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if (finishedCount === models.length || runState.cancelled) {
              clearInterval(interval);
              resolve();
            }
          }, 500);

          // Also clean up on abort
          if (signal) {
            signal.addEventListener("abort", () => {
              clearInterval(interval);
              resolve();
            }, { once: true });
          }
        });

        if (timeoutTimer) clearTimeout(timeoutTimer);
        cleanup();
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
