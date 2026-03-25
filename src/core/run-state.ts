import * as fs from "node:fs";
import * as path from "node:path";
import { pidAlive } from "../util/pid.js";
import { agentPaths } from "./runner.js";
import { parseStream } from "./stream-parser.js";
import type { ModelSpec } from "./config.js";

export type WorkerStatus = "running" | "stalled" | "done" | "failed";

export interface WorkerState {
  id: string;
  provider: string;
  model: string;
  status: WorkerStatus;
  pid: number | null;
  toolCalls: number;
  events: number;
  preview: string;
  finalText: string;
  errorMessage: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

export interface RunMeta {
  runId: string;
  prompt: string;
  startedAt: number;
  agents: ModelSpec[];
  cwd: string;
}

export function loadMeta(runDir: string): RunMeta | null {
  const metaPath = path.join(runDir, "meta.json");
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

export function refreshWorker(runDir: string, model: ModelSpec, stallSeconds: number): WorkerState {
  const paths = agentPaths(runDir, model.id);
  const parsed = parseStream(paths.stream);

  let pid: number | null = null;
  if (fs.existsSync(paths.pid)) {
    try {
      pid = parseInt(fs.readFileSync(paths.pid, "utf-8").trim(), 10);
    } catch {
      pid = null;
    }
  }

  const isDone = fs.existsSync(paths.done);
  const isAlive = pid !== null && pidAlive(pid);

  // Mark done if process exited
  if (!isDone && pid !== null && !isAlive) {
    try {
      fs.writeFileSync(paths.done, "");
    } catch {
      // ignore
    }
  }

  let status: WorkerStatus;
  if (isDone || (!isAlive && pid !== null)) {
    status = parsed.finalText || parsed.assistantText ? "done" : "failed";
  } else if (isAlive) {
    // Check stall
    let lastMtime = 0;
    for (const p of [paths.stream, paths.err]) {
      if (fs.existsSync(p)) {
        const mtime = fs.statSync(p).mtimeMs;
        if (mtime > lastMtime) lastMtime = mtime;
      }
    }
    const age = (Date.now() - lastMtime) / 1000;
    status = age > stallSeconds ? "stalled" : "running";
  } else {
    status = "failed";
  }

  const errText = fs.existsSync(paths.err)
    ? fs.readFileSync(paths.err, "utf-8").trim()
    : "";

  const preview = (parsed.assistantText || parsed.finalText || "").replace(/\n/g, " ").slice(0, 120);

  return {
    id: model.id,
    provider: model.provider,
    model: model.model,
    status,
    pid,
    toolCalls: parsed.toolCalls,
    events: parsed.events,
    preview,
    finalText: parsed.finalText || parsed.assistantText || "",
    errorMessage: parsed.errorMessage || (status === "failed" ? errText.slice(0, 500) || "empty output" : null),
    usage: parsed.usage,
  };
}

export function refreshRun(
  runDir: string,
  agents: ModelSpec[],
  stallSeconds: number,
): WorkerState[] {
  return agents.map((a) => refreshWorker(runDir, a, stallSeconds));
}
