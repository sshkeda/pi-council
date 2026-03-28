/**
 * pi-council extension — registers council tools for the orchestrator.
 *
 * Tools:
 *   spawn_council    — spawn a new council (profile or custom)
 *   council_followup — send abort/steer to running members
 *   cancel_council   — cancel individual member or entire council
 *   council_status   — get status of all members
 *   read_stream      — read a member's accumulated output
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Council, CouncilRegistry } from "../../src/core/council.js";
import { loadConfig } from "../../src/core/config.js";
import type { ModelSpec, CouncilEvent } from "../../src/core/types.js";

export default function (pi: ExtensionAPI) {
  const registry = new CouncilRegistry();

  // ─── spawn_council ─────────────────────────────────────────────────
  pi.registerTool({
    name: "spawn_council",
    label: "Spawn Council",
    description:
      "Spawn multiple AI models in parallel to get independent opinions. " +
      "Returns immediately — results auto-delivered. " +
      "Each model is a separate pi agent with its own tools and context.",
    promptSnippet:
      "Spawn multiple AI models for independent opinions. Returns immediately; results auto-delivered via followUp.",
    promptGuidelines: [
      "Use spawn_council when you need diverse perspectives on a question.",
      "After calling spawn_council, continue your foreground work. Each model's result is delivered as soon as it finishes, and a final combined summary arrives when all are done.",
      "Each model is a separate agent with its own tools. They do their own research independently.",
      "The point is surfacing disagreement, not consensus. Pay attention to the dissenter.",
      "IMPORTANT: When formulating the question, strip your own conclusions and opinions. Present context neutrally. Do NOT lead the models toward a particular answer. The value comes from unbiased, independent perspectives.",
      "Do NOT include your own analysis or preferred solution in the question. Instead, present the raw situation and ask for their assessment.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "Question for the council. Frame it neutrally — do not inject your own opinions or conclusions." }),
      models: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Model IDs to use (default: all 4). e.g. ["claude", "grok"]',
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const isInteractive = ctx.hasUI;

      const council = new Council(params.question);
      registry.add(council);

      let finishedCount = 0;
      let delivered = false;

      council.on((event: CouncilEvent) => {
        // Deliver each member's result as it finishes — every member, including the last
        if (event.type === "member_done" || event.type === "member_failed") {
          finishedCount++;
          const totalMembers = council.getMembers().length;
          ctx.ui.setStatus("council", `🏛️ Council: ${finishedCount}/${totalMembers} done`);

          if (isInteractive) {
            const memberId = (event as { memberId: string }).memberId;
            const member = council.getMember(memberId);
            if (member) {
              const status = member.getStatus();
              const icon = status.state === "done" ? "✅" : "❌";
              const duration = status.durationMs ? `${(status.durationMs / 1000).toFixed(1)}s` : "";
              const outputLen = status.output?.length ?? 0;
              const memberFile = `${council.getRunDir()}/${memberId}.json`;

              // Compact notification — full output is on disk
              const lines = [
                `🏛️ ${icon} ${status.id.toUpperCase()} (${status.model.model}) — ${finishedCount}/${totalMembers} done${duration ? ` (${duration})` : ""}`,
                ``,
                outputLen > 0
                  ? `${status.output}`
                  : status.error
                    ? `Error: ${status.error}`
                    : "(no output)",
              ];

              pi.sendMessage(
                {
                  customType: "council-progress",
                  content: lines.join("\n"),
                  display: true,
                },
                { deliverAs: "followUp", triggerTurn: false },
              );
            }
          }
        }

        // Deliver final combined result
        if (event.type === "council_complete" && isInteractive && !delivered) {
          delivered = true;
          ctx.ui.setStatus("council", undefined);
          // Clean up registry to prevent memory leak — keep last 5 runs
          const all = registry.list();
          if (all.length > 5) {
            for (const old of all.slice(0, all.length - 5)) {
              registry.remove(old.runId);
            }
          }

          const result = council.getResult();
          const succeeded = result.members.filter(m => m.state === "done").length;
          const failedCount = result.members.filter(m => m.state !== "done").length;
          const totalDuration = Math.max(...result.members.map(m => m.durationMs ?? 0));
          const totalCost = result.members.reduce((sum, m) => sum + (m.stats?.cost ?? 0), 0);
          const totalTokens = result.members.reduce((sum, m) => sum + (m.stats?.tokens?.total ?? 0), 0);

          const costLine = totalCost > 0 ? `\n- total cost: $${totalCost.toFixed(4)}` : "";
          const tokensLine = totalTokens > 0 ? `\n- total tokens: ${totalTokens}` : "";
          const ttfrLine = result.ttfrMs ? `\n- time to first result: ${(result.ttfrMs / 1000).toFixed(1)}s` : "";

          // Only send summary metadata — individual results were already
          // delivered as intermediates. Full output is in results.json/md.
          const summary = [
            `🏛️ All ${result.members.length} council members responded for: "${result.prompt}"`,
            ``,
            `Summary:`,
            `- total: ${result.members.length}`,
            `- succeeded: ${succeeded}`,
            `- failed: ${failedCount}`,
            `- total duration: ${(totalDuration / 1000).toFixed(1)}s${ttfrLine}${costLine}${tokensLine}`,
            ``,
            `Full results: ${council.getRunDir()}/results.md`,
          ].join("\n");

          pi.sendMessage(
            {
              customType: "council-result",
              content: summary,
              display: true,
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        }
      });

      try {
        const config = loadConfig();
        const spawnOptions: Record<string, unknown> = {
          cwd: ctx.cwd,
        };

        if (config.systemPrompt) {
          spawnOptions.systemPrompt = config.systemPrompt;
        }

        if (params.models && params.models.length > 0) {
          const resolved = config.models.filter((m) =>
            params.models!.some((id) => id.toLowerCase() === m.id.toLowerCase()),
          );
          if (resolved.length > 0) {
            spawnOptions.models = resolved;
          } else {
            spawnOptions.models = config.models;
          }
        } else {
          spawnOptions.models = config.models;
        }

        council.spawn(spawnOptions as any);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to spawn council: ${msg}` }],
          details: {},
        };
      }

      const memberNames = council.getMembers().map((m) => m.id).join(", ");

      // Non-interactive: block until done
      if (!isInteractive) {
        const result = await council.waitForCompletion();
        const summary = result.members
          .map((m) => {
            const icon = m.state === "done" ? "✅" : "❌";
            return `## ${icon} ${m.id.toUpperCase()} (${m.model.model})\n\n${m.output || m.error || "(no output)"}`;
          })
          .join("\n\n---\n\n");

        return {
          content: [{ type: "text", text: `🏛️ Council results:\n\n${summary}` }],
          details: { runId: council.runId, models: memberNames },
        };
      }

      // Interactive: return immediately
      return {
        content: [
          {
            type: "text",
            text:
              `Council spawned: ${memberNames} (run: ${council.runId})\n` +
              `Results will be delivered automatically when all agents finish.\n` +
              `Continue with your other work.`,
          },
        ],
        details: { runId: council.runId, models: memberNames },
      };
    },
  });

  // ─── council_followup ──────────────────────────────────────────────
  pi.registerTool({
    name: "council_followup",
    label: "Council Follow-up",
    description:
      "Send a follow-up message to running council members. " +
      "Type 'abort' interrupts immediately and injects new context. " +
      "Type 'steer' queues the message for after the current tool call completes.",
    promptSnippet: "Send abort or steer follow-up to council members.",
    parameters: Type.Object({
      message: Type.String({ description: "The follow-up message to send" }),
      type: Type.Union([Type.Literal("abort"), Type.Literal("steer")], {
        description: '"abort" to interrupt immediately, "steer" to queue after current tool call',
      }),
      runId: Type.Optional(Type.String({ description: "Run ID. Omit for most recent council." })),
      memberIds: Type.Optional(
        Type.Array(Type.String(), {
          description: "Target specific members. Omit to send to all running members.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const council = params.runId ? registry.get(params.runId) : registry.getLatest();
      if (!council) {
        return { content: [{ type: "text" as const, text: "No active council found." }], details: {} as Record<string, unknown> };
      }

      try {
        await council.followUp({
          type: params.type,
          message: params.message,
          memberIds: params.memberIds,
        });
        const targetDesc = params.memberIds ? params.memberIds.join(", ") : "all running members";
        return {
          content: [{ type: "text" as const, text: `Sent ${params.type} follow-up to ${targetDesc}: "${params.message}"` }],
          details: { runId: council.runId, type: params.type } as Record<string, unknown>,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Follow-up failed: ${msg}` }], details: {} as Record<string, unknown> };
      }
    },
  });

  // ─── cancel_council ────────────────────────────────────────────────
  pi.registerTool({
    name: "cancel_council",
    label: "Cancel Council",
    description: "Cancel a running council or specific members.",
    promptSnippet: "Cancel a running council or specific members.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "Run ID. Omit for most recent." })),
      memberIds: Type.Optional(
        Type.Array(Type.String(), {
          description: "Cancel specific members. Omit to cancel entire council.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const council = params.runId ? registry.get(params.runId) : registry.getLatest();
      if (!council) {
        return { content: [{ type: "text" as const, text: "No active council found." }], details: {} as Record<string, unknown> };
      }

      council.cancel(params.memberIds);
      const desc = params.memberIds
        ? `Cancelled members: ${params.memberIds.join(", ")}`
        : `Cancelled entire council: ${council.runId}`;
      return { content: [{ type: "text" as const, text: desc }], details: { runId: council.runId } as Record<string, unknown> };
    },
  });

  // ─── council_status ────────────────────────────────────────────────
  pi.registerTool({
    name: "council_status",
    label: "Council Status",
    description: "Get detailed status of a council and all its members.",
    promptSnippet: "Check council status — see which members are running, done, or failed.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "Run ID. Omit for most recent." })),
    }),
    async execute(_toolCallId, params) {
      const council = params.runId ? registry.get(params.runId) : registry.getLatest();
      if (!council) {
        return { content: [{ type: "text" as const, text: "No active council found." }], details: {} as Record<string, unknown> };
      }

      const status = council.getStatus();
      const lines = [
        `Council: ${status.runId}`,
        `Prompt: "${status.prompt}"`,
        `Progress: ${status.finishedCount}/${status.members.length} done`,
        `Complete: ${status.isComplete}`,
        "",
        ...status.members.map((m) => {
          const icon = m.state === "done" ? "✅" : m.state === "running" ? "🔄" : "❌";
          const elapsed = m.durationMs
            ? ` (${(m.durationMs / 1000).toFixed(1)}s)`
            : m.state === "running"
              ? ` (${((Date.now() - m.startedAt) / 1000).toFixed(0)}s elapsed)`
              : "";
          const streaming = m.isStreaming ? " [streaming]" : m.state === "running" ? " [waiting]" : "";
          const errMsg = m.error ? `\n    error: ${m.error}` : "";
          const stderrMsg = m.stderr ? `\n    stderr: ${m.stderr.slice(0, 200)}` : "";
          const outputLen = m.output ? `\n    output: ${m.output.length} chars` : "\n    output: (none)";
          const outputPreview = m.output ? `\n    preview: ${m.output.slice(0, 120).replace(/\n/g, " ")}` : "";
          return `${icon} ${m.id} (${m.model.model}): ${m.state}${elapsed}${streaming}${errMsg}${stderrMsg}${outputLen}${outputPreview}`;
        }),
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { runId: status.runId, complete: status.isComplete } as Record<string, unknown>,
      };
    },
  });

  // ─── read_stream ───────────────────────────────────────────────────
  pi.registerTool({
    name: "read_stream",
    label: "Read Council Stream",
    description: "Read the accumulated output of a specific council member.",
    promptSnippet: "Read a council member's full output stream.",
    parameters: Type.Object({
      memberId: Type.String({ description: 'Member ID (e.g. "claude", "gpt")' }),
      runId: Type.Optional(Type.String({ description: "Run ID. Omit for most recent." })),
    }),
    async execute(_toolCallId, params) {
      const council = params.runId ? registry.get(params.runId) : registry.getLatest();
      if (!council) {
        return { content: [{ type: "text" as const, text: "No active council found." }], details: {} as Record<string, unknown> };
      }

      try {
        const output = council.readStream(params.memberId);
        const member = council.getMember(params.memberId)!;
        const status = member.getStatus();

        const elapsed = status.durationMs
          ? `${(status.durationMs / 1000).toFixed(1)}s`
          : status.state === "running"
            ? `${((Date.now() - status.startedAt) / 1000).toFixed(0)}s elapsed`
            : "";

        const sections = [
          `## ${params.memberId.toUpperCase()} (${status.model.model}) — ${status.state}${elapsed ? ` (${elapsed})` : ""}`,
          status.isStreaming ? `\n*Currently streaming*` : "",
          status.stderr ? `\n### stderr\n\`\`\`\n${status.stderr}\n\`\`\`` : "",
          status.error ? `\n### error\n${status.error}` : "",
          `\n### output (${output.length} chars)\n${output || "(no output yet)"}`,
        ].filter(Boolean).join("\n");

        return {
          content: [{ type: "text" as const, text: sections }],
          details: { memberId: params.memberId, state: status.state, runId: council.runId, isStreaming: status.isStreaming, outputLength: output.length, hasStderr: status.stderr.length > 0 } as Record<string, unknown>,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], details: {} as Record<string, unknown> };
      }
    },
  });
}
