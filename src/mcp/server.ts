import * as fs from "node:fs";
import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { Council, registry } from "../core/council.js";
import { cleanupRun, listRuns, readRunMeta, readRunResults, resolveRunId, waitForRunResults } from "../core/runs.js";
import { loadConfig, resolveModelIds, resolveProfile } from "../core/config.js";
import { getRunDir } from "../core/storage.js";
import type { ModelSpec } from "../core/types.js";

const server = new Server(
  { name: "pi-council", version: "0.1.1" },
  { capabilities: { tools: {} } },
);

const tools: Tool[] = [
  {
    name: "spawn_council",
    description: "Spawn multiple AI models in parallel and return immediately with a runId.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: { type: "string", description: "Question for the council. Frame it neutrally." },
        models: { type: "array", items: { type: "string" }, description: "Explicit model IDs to use." },
        profile: { type: "string", description: "Named profile from ~/.pi-council/config.json." },
        cwd: { type: "string", description: "Working directory for council members." },
        label: { type: "string", description: "Optional human label for the run." },
      },
    },
  },
  {
    name: "council_followup",
    description: "Send a steer or abort follow-up to a running council.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["message", "type"],
      properties: {
        message: { type: "string" },
        type: { type: "string", enum: ["abort", "steer"] },
        runId: { type: "string" },
        memberIds: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "cancel_council",
    description: "Cancel specific members or the entire running council.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string" },
        memberIds: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "council_status",
    description: "Get status for a live council, or read persisted status/results from disk.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string" },
      },
    },
  },
  {
    name: "read_council_stream",
    description: "Read a member's accumulated output/thinking/stderr from a live council or persisted member file.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["memberId"],
      properties: {
        memberId: { type: "string" },
        runId: { type: "string" },
      },
    },
  },
  {
    name: "list_council_runs",
    description: "List council runs found under ~/.pi-council/runs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "read_council_results",
    description: "Read persisted council results from disk, optionally waiting for completion.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string" },
        wait: { type: "boolean", description: "Wait for completion if results are not available yet." },
        timeoutMs: { type: "number", minimum: 1 },
      },
    },
  },
  {
    name: "cleanup_council_runs",
    description: "Delete persisted run artifacts. Does not cancel live members unless you call cancel_council separately.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string" },
        all: { type: "boolean" },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "spawn_council": {
        const question = String(args.question ?? "").trim();
        if (!question) throw new Error("question is required");

        const { models, systemPrompt, thinking, memberTimeoutMs } = resolveSpawnSelection(args.models, args.profile);
        const council = new Council(question);
        registry.add(council);

        const spawnOptions: {
          models: ModelSpec[];
          systemPrompt?: string;
          thinking?: string;
          cwd?: string;
          memberTimeoutMs?: number;
        } = {
          models,
          ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(thinking ? { thinking } : {}),
          ...(memberTimeoutMs ? { memberTimeoutMs } : {}),
        };

        council.spawn(spawnOptions);

        return ok({
          runId: council.runId,
          question,
          label: typeof args.label === "string" ? args.label : undefined,
          models: models.map((model) => ({ id: model.id, provider: model.provider, model: model.model })),
          runDir: council.getRunDir(),
          status: "running",
        });
      }

      case "council_followup": {
        const council = requireLiveCouncil(args.runId);
        const message = String(args.message ?? "").trim();
        const type = String(args.type ?? "");
        if (!message) throw new Error("message is required");
        if (type !== "abort" && type !== "steer") throw new Error("type must be 'abort' or 'steer'");

        await council.followUp({
          message,
          type,
          memberIds: toStringArray(args.memberIds),
        });

        return ok({ runId: council.runId, delivered: true, type, memberIds: toStringArray(args.memberIds) ?? "all-live-members" });
      }

      case "cancel_council": {
        const council = requireLiveCouncil(args.runId);
        const memberIds = toStringArray(args.memberIds);
        council.cancel(memberIds);
        return ok({ runId: council.runId, cancelled: memberIds ?? "all-members" });
      }

      case "council_status": {
        const runId = typeof args.runId === "string" ? args.runId : undefined;
        const live = getLiveCouncil(runId);
        if (live) {
          return ok({
            source: "live",
            runId: live.runId,
            runDir: live.getRunDir(),
            status: live.getStatus(),
          });
        }

        const disk = readStatusFromDisk(runId);
        if (disk) return ok(disk);
        throw new Error(runId ? `Unknown runId: ${runId}` : "No council runs found.");
      }

      case "read_council_stream": {
        const memberId = String(args.memberId ?? "").trim();
        if (!memberId) throw new Error("memberId is required");
        const runId = typeof args.runId === "string" ? args.runId : undefined;

        const live = getLiveCouncil(runId);
        if (live) {
          const member = live.getMember(memberId);
          if (!member) throw new Error(`Unknown member: ${memberId}`);
          return ok({
            source: "live",
            runId: live.runId,
            memberId,
            status: member.getStatus(),
          });
        }

        const persisted = readMemberFromDisk(runId, memberId);
        if (persisted) return ok(persisted);
        throw new Error(`No live or persisted stream found for member '${memberId}'.`);
      }

      case "list_council_runs": {
        return ok({ runs: listRuns() });
      }

      case "read_council_results": {
        const runId = typeof args.runId === "string" ? args.runId : undefined;
        const wait = args.wait === true;
        const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 600_000;

        const live = getLiveCouncil(runId);
        if (live && wait) {
          const result = await live.waitForCompletion();
          return ok({ source: "live", runId: live.runId, result });
        }

        const immediate = readRunResults(runId);
        if (immediate) {
          return ok({ source: "disk", runId: resolveRunId(runId), result: immediate });
        }

        if (!wait) {
          const meta = readRunMeta(runId);
          return ok({
            source: meta ? "disk" : "none",
            runId: resolveRunId(runId),
            result: null,
            meta,
            message: meta ? "Results are not available yet." : "No council runs found.",
          });
        }

        const waited = await waitForRunResults(runId, timeoutMs);
        return ok({ source: waited ? "disk" : "none", runId: resolveRunId(runId), result: waited ?? null });
      }

      case "cleanup_council_runs": {
        const runId = typeof args.runId === "string" ? args.runId : undefined;
        const all = args.all === true;
        const removed = cleanupRun(all ? "--all" : runId);
        return ok({ removed: removed.removed });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
});

function resolveSpawnSelection(modelsArg: unknown, profileArg: unknown): {
  models: ModelSpec[];
  systemPrompt?: string;
  thinking?: string;
  memberTimeoutMs?: number;
} {
  const config = loadConfig();

  if (Array.isArray(modelsArg) && modelsArg.length > 0) {
    const requested = modelsArg.map(String);
    const models = resolveModelIds(config, requested);
    if (models.length === 0) {
      const available = Object.keys(config.models).join(", ");
      throw new Error(`No matching models found. Available: ${available}`);
    }
    return { models };
  }

  const resolved = resolveProfile(
    config,
    typeof profileArg === "string" && profileArg.trim().length > 0 ? profileArg : undefined,
  );

  return {
    models: resolved.models,
    systemPrompt: resolved.systemPrompt,
    thinking: resolved.thinking,
    memberTimeoutMs: resolved.memberTimeoutMs,
  };
}

function getLiveCouncil(runId?: string): Council | undefined {
  return runId ? registry.get(runId) : registry.getLatest();
}

function requireLiveCouncil(runId?: unknown): Council {
  const council = getLiveCouncil(typeof runId === "string" ? runId : undefined);
  if (!council) {
    throw new Error(
      runId
        ? `Run '${String(runId)}' is not active in this MCP server process. Use council_status/read_council_results for persisted runs.`
        : "No live council found in this MCP server process.",
    );
  }
  return council;
}

function readStatusFromDisk(runId?: string): Record<string, unknown> | undefined {
  const targetId = resolveRunId(runId);
  if (!targetId) return undefined;

  const results = readRunResults(targetId);
  if (results) {
    return {
      source: "disk",
      runId: targetId,
      status: "complete",
      results,
    };
  }

  const meta = readRunMeta(targetId);
  if (meta) {
    return {
      source: "disk",
      runId: targetId,
      status: "running_or_incomplete",
      meta,
    };
  }

  return undefined;
}

function readMemberFromDisk(runId: string | undefined, memberId: string): Record<string, unknown> | undefined {
  const targetId = resolveRunId(runId);
  if (!targetId) return undefined;

  const memberPath = path.join(getRunDir(targetId), `${memberId}.json`);
  if (fs.existsSync(memberPath)) {
    try {
      return {
        source: "disk",
        runId: targetId,
        memberId,
        status: JSON.parse(fs.readFileSync(memberPath, "utf-8")) as Record<string, unknown>,
      };
    } catch {}
  }

  const results = readRunResults(targetId) as { members?: Array<Record<string, unknown>> } | undefined;
  const member = results?.members?.find((candidate) => candidate.id === memberId);
  if (member) {
    return {
      source: "disk",
      runId: targetId,
      memberId,
      status: member,
    };
  }

  return undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(String).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function ok(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function shutdown(): void {
  for (const council of registry.active()) {
    try {
      council.cancel();
    } catch {}
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`pi-council MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
