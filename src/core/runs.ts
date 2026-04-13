import * as fs from "node:fs";
import * as path from "node:path";
import { getLatestRunId, getRunDir, getRunsDir } from "./storage.js";

export interface RunListEntry {
  runId: string;
  status: "running" | "complete";
  prompt?: string;
  models?: string[];
  startedAt?: number;
  completedAt?: number;
  ttfrMs?: number;
}

export function listRuns(): RunListEntry[] {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) return [];

  return fs.readdirSync(runsDir).sort().reverse().map((runId) => {
    const metaPath = path.join(runsDir, runId, "meta.json");
    const resultsPath = path.join(runsDir, runId, "results.json");
    const entry: RunListEntry = {
      runId,
      status: fs.existsSync(resultsPath) ? "complete" : "running",
    };

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
        prompt?: string;
        models?: Array<{ id?: string }>;
        startedAt?: number;
      };
      entry.prompt = meta.prompt;
      entry.models = (meta.models ?? []).map((model) => String(model.id ?? "")).filter(Boolean);
      entry.startedAt = meta.startedAt;
    } catch {}

    if (fs.existsSync(resultsPath)) {
      try {
        const results = JSON.parse(fs.readFileSync(resultsPath, "utf-8")) as {
          completedAt?: number;
          ttfrMs?: number;
        };
        entry.completedAt = results.completedAt;
        entry.ttfrMs = results.ttfrMs;
      } catch {}
    }

    return entry;
  });
}

export function resolveRunId(runId?: string): string | undefined {
  return runId ?? getLatestRunId();
}

export function readRunMeta(runId?: string): Record<string, unknown> | undefined {
  const targetId = resolveRunId(runId);
  if (!targetId) return undefined;

  const metaPath = path.join(getRunDir(targetId), "meta.json");
  if (!fs.existsSync(metaPath)) return undefined;

  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function readRunResults(runId?: string): Record<string, unknown> | undefined {
  const targetId = resolveRunId(runId);
  if (!targetId) return undefined;

  const resultsPath = path.join(getRunDir(targetId), "results.json");
  if (!fs.existsSync(resultsPath)) return undefined;

  try {
    return JSON.parse(fs.readFileSync(resultsPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function waitForRunResults(runId?: string, timeoutMs = 600_000): Promise<Record<string, unknown> | undefined> {
  const targetId = resolveRunId(runId);
  if (!targetId) return undefined;

  const resultsPath = path.join(getRunDir(targetId), "results.json");
  const start = Date.now();

  while (Date.now() - start <= timeoutMs) {
    if (fs.existsSync(resultsPath)) {
      return readRunResults(targetId);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return readRunResults(targetId);
}

export function cleanupRun(runId?: string | "--all"): { removed: string[] } {
  if (runId === "--all") {
    const runsDir = getRunsDir();
    if (!fs.existsSync(runsDir)) return { removed: [] };

    const removed: string[] = [];
    for (const dir of fs.readdirSync(runsDir)) {
      fs.rmSync(path.join(runsDir, dir), { recursive: true, force: true });
      removed.push(dir);
    }
    return { removed };
  }

  const targetId = resolveRunId(runId);
  if (!targetId) return { removed: [] };

  const runDir = getRunDir(targetId);
  if (!fs.existsSync(runDir)) return { removed: [] };

  fs.rmSync(runDir, { recursive: true, force: true });
  return { removed: [targetId] };
}
