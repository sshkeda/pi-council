import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadConfig, resolveModels, createRun } from "../../src/core/config.js";
import type { ModelSpec } from "../../src/core/config.js";
import { CouncilSession } from "../../src/core/session.js";

export default function (pi: ExtensionAPI) {
  const activeSessions = new Map<string, CouncilSession>();

  pi.registerTool({
    name: "cancel_council",
    label: "Cancel Council",
    description: "Cancel a running council by run ID, or cancel the most recent one.",
    promptSnippet: "Cancel a running council.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "Run ID to cancel. Omit to cancel the most recent." })),
    }),
    async execute(_id, params) {
      let targetId = params.runId;
      if (!targetId) {
        const keys = [...activeSessions.keys()];
        if (keys.length === 0) return { content: [{ type: "text", text: "No active councils." }], details: {} };
        targetId = keys[keys.length - 1];
      }
      const session = activeSessions.get(targetId);
      if (!session) return { content: [{ type: "text", text: `No active council: ${targetId}` }], details: {} };
      session.cancel();
      activeSessions.delete(targetId);
      return { content: [{ type: "text", text: `Cancelled: ${targetId}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "spawn_council",
    label: "Spawn Council",
    description:
      "Spawn multiple AI models in parallel to get independent opinions. Returns immediately — results auto-delivered.",
    promptSnippet:
      "Spawn 4 AI models for independent opinions. Returns immediately; results auto-delivered via followUp.",
    promptGuidelines: [
      "Use spawn_council for diverse perspectives on architecture, code review, investment analysis, or high-stakes decisions.",
      "After calling, continue working. Results arrive automatically as a followUp message.",
      "Each model is a separate pi instance with its own tools, doing independent research.",
      "The point is surfacing disagreement, not consensus. Pay attention to the dissenter.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "Question for the council" }),
      models: Type.Optional(Type.Array(Type.String(), { description: 'Model IDs e.g. ["claude", "grok"]' })),
    }),
    async execute(_id, params, signal, _upd, ctx) {
      const isInteractive = ctx.hasUI;
      const config = loadConfig();
      let models: ModelSpec[];
      try {
        models = resolveModels(config, params.models);
      } catch (err) {
        return { content: [{ type: "text", text: (err as Error).message }], details: {} };
      }
      if (models.length === 0) return { content: [{ type: "text", text: "No valid models selected." }], details: {} };

      const { runId, runDir } = createRun(params.question, models, ctx.cwd);
      let delivered = false;

      const deliver = (content: string) => {
        if (delivered || !isInteractive) return;
        delivered = true;
        session.dispose();
        activeSessions.delete(runId);
        if (isInteractive) ctx.ui.setStatus("council", undefined);
        pi.sendMessage(
          { customType: "council-result", content, display: true },
          { deliverAs: "followUp", triggerTurn: true },
        );
      };

      const session = new CouncilSession({
        runId,
        runDir,
        prompt: params.question,
        models,
        config,
        cwd: ctx.cwd,
        events: {
          onFinished(_a, done, total) {
            if (isInteractive && !session.isCancelled) ctx.ui.setStatus("council", `🏛️ Council: ${done}/${total} done`);
          },
          onAllDone() {
            deliver(`🏛️ Council results for: "${params.question}"\n\n${session.summary()}`);
          },
          onTimeout(_a, secs) {
            deliver(`🏛️ Council (⏰ ${secs}s timeout):\n\n${session.summary()}`);
          },
          onCancelled() {
            activeSessions.delete(runId);
            if (isInteractive) ctx.ui.setStatus("council", undefined);
          },
        },
      });

      activeSessions.set(runId, session);
      if (signal)
        signal.addEventListener(
          "abort",
          () => {
            session.cancel();
            activeSessions.delete(runId);
          },
          { once: true },
        );

      if (!session.start()) {
        session.dispose();
        activeSessions.delete(runId);
        return { content: [{ type: "text", text: "Failed to spawn agents." }], details: {} };
      }

      if (!isInteractive) {
        await session.wait();
        session.dispose();
        activeSessions.delete(runId);
        return {
          content: [{ type: "text", text: `🏛️ Council results:\n\n${session.summary()}` }],
          details: { runId, models: session.modelNames },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Council spawned: ${session.modelNames} (run: ${runId})\nResults delivered automatically.`,
          },
        ],
        details: { runId, models: session.modelNames },
      };
    },
  });
}
