/**
 * pi-council extension — registers spawn_council and cancel_council tools.
 *
 * Uses CouncilSession from shared core for orchestration — same logic as the CLI.
 * Only the UI integration (pi extension status, followUp delivery) is extension-specific.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { loadConfig, resolveModels, type ModelSpec } from "../../src/core/config.js";
import { createRun } from "../../src/core/run-lifecycle.js";
import { CouncilSession } from "../../src/core/council-session.js";

export default function (pi: ExtensionAPI) {
  // Track active sessions so we can cancel them
  const activeSessions = new Map<string, CouncilSession>();

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
        const keys = [...activeSessions.keys()];
        if (keys.length === 0) {
          return { content: [{ type: "text", text: "No active councils to cancel." }], details: {} };
        }
        targetId = keys[keys.length - 1];
      }

      const session = activeSessions.get(targetId);
      if (!session) {
        return { content: [{ type: "text", text: `No active council with ID: ${targetId}` }], details: {} };
      }

      session.cancel();
      activeSessions.delete(targetId);

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
        return { content: [{ type: "text", text: (err as Error).message }], details: {} };
      }

      if (models.length === 0) {
        return { content: [{ type: "text", text: "No valid models selected." }], details: {} };
      }

      const { runId, runDir } = createRun(params.question, models, ctx.cwd);

      let delivered = false;

      function deliver(content: string): void {
        if (delivered || !isInteractive) return;
        delivered = true;
        session.dispose();
        activeSessions.delete(runId);
        if (isInteractive) ctx.ui.setStatus("council", undefined);
        pi.sendMessage(
          { customType: "council-result", content, display: true },
          { deliverAs: "followUp", triggerTurn: true },
        );
      }

      const session = new CouncilSession({
        runId, runDir,
        prompt: params.question,
        models, config,
        cwd: ctx.cwd,
        events: {
          onFinished(_agent, done, total) {
            if (isInteractive && !session.isCancelled) {
              ctx.ui.setStatus("council", `🏛️ Council: ${done}/${total} done`);
            }
          },
          onAllDone() {
            deliver(`🏛️ Council results for: "${params.question}"\n\n${session.buildSummary()}`);
          },
          onTimeout(_agents, secs) {
            deliver(`🏛️ Council results (⏰ timed out after ${secs}s):\n\n${session.buildSummary()}`);
          },
          onCancelled() {
            // Don't deliver on cancel — user explicitly cancelled
            activeSessions.delete(runId);
            if (isInteractive) ctx.ui.setStatus("council", undefined);
          },
        },
      });

      activeSessions.set(runId, session);

      // Handle AbortSignal
      if (signal) {
        signal.addEventListener("abort", () => {
          session.cancel();
          activeSessions.delete(runId);
        }, { once: true });
      }

      const started = session.start();
      if (!started) {
        session.dispose();
        activeSessions.delete(runId);
        return {
          content: [{ type: "text", text: "Failed to spawn council agents. Check that 'pi' is installed." }],
          details: {},
        };
      }

      const modelNames = session.modelNames;

      // Non-interactive: block until done
      if (!isInteractive) {
        await session.waitForCompletion();
        session.dispose();
        activeSessions.delete(runId);
        return {
          content: [{ type: "text", text: `🏛️ Council results:\n\n${session.buildSummary()}` }],
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
