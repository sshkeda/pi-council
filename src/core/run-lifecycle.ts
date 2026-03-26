import * as fs from "node:fs";
import * as path from "node:path";
import { getRunsDir, getLatestFile, type ModelSpec } from "./config.js";
import { agentPaths } from "./runner.js";
import { killPid } from "../util/pid.js";
import { generateRunId } from "../util/run-id.js";
import type { RunMeta } from "./run-state.js";

export interface CreateRunResult {
  runId: string;
  runDir: string;
  meta: RunMeta;
}

/**
 * Create a new council run: generate ID, create directory, write prompt + meta + latest.
 * Single source of truth — used by CLI ask, CLI spawn, and the pi extension.
 */
export function createRun(prompt: string, models: ModelSpec[], cwd: string): CreateRunResult {
  const runId = generateRunId();
  const runDir = path.join(getRunsDir(), runId);
  fs.mkdirSync(runDir, { recursive: true });

  fs.writeFileSync(path.join(runDir, "prompt.txt"), prompt);

  const meta: RunMeta = {
    runId,
    prompt,
    startedAt: Date.now(),
    agents: models,
    cwd,
  };
  fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
  fs.writeFileSync(getLatestFile(), runId);

  return { runId, runDir, meta };
}

/**
 * Kill all agent workers for a run. Reads PIDs from .pid files and sends SIGTERM.
 * Optionally marks unfinished agents as cancelled by writing .done markers.
 */
export function killAllAgents(runDir: string, agents: ModelSpec[], markCancelled = false): void {
  for (const agent of agents) {
    const paths = agentPaths(runDir, agent.id);
    try {
      const raw = parseInt(fs.readFileSync(paths.pid, "utf-8").trim(), 10);
      if (Number.isFinite(raw)) killPid(raw);
    } catch {
      // PID file missing or unreadable — agent may not have started
    }
    if (markCancelled) {
      // Write-once: don't overwrite existing .done markers
      try { fs.writeFileSync(paths.done, "cancelled", { flag: "wx" }); } catch {}
    }
  }
}
