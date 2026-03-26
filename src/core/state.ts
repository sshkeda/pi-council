/** Run state — reads file-based state for background runs (status, results, watch, list, cleanup). */

import * as fs from "node:fs";
import * as path from "node:path";
import { agentPaths, parseStream } from "./runner.js";
import type { ModelSpec, RunMeta } from "./config.js";

export type WorkerStatus = "running" | "done" | "failed";

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

export function loadMeta(runDir: string): RunMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf-8"));
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPid(pidPath: string): number | null {
  try {
    const n = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function killPid(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  if (!pidAlive(pid)) return;
  setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }, 2000).unref();
}

export function isAgentDone(runDir: string, model: ModelSpec): boolean {
  const paths = agentPaths(runDir, model.id);
  try {
    fs.accessSync(paths.done);
    return true;
  } catch {}
  const pid = readPid(paths.pid);
  if (pid === null) return false;
  if (!pidAlive(pid)) {
    try {
      fs.writeFileSync(paths.done, "", { flag: "wx" });
    } catch {}
    return true;
  }
  return false;
}

export function refreshWorker(runDir: string, model: ModelSpec): WorkerState {
  const paths = agentPaths(runDir, model.id);
  const parsed = parseStream(paths.stream);
  const pid = readPid(paths.pid);
  const isDone = fs.existsSync(paths.done);
  const isAlive = pid !== null && pidAlive(pid);

  if (!isDone && pid !== null && !isAlive) {
    try {
      fs.writeFileSync(paths.done, "", { flag: "wx" });
    } catch {}
  }

  let exitCode: string | null = null;
  if (isDone || (!isAlive && pid !== null)) {
    try {
      exitCode = fs.readFileSync(paths.done, "utf-8").trim();
    } catch {}
  }

  let status: WorkerStatus;
  if (isDone || (!isAlive && pid !== null)) {
    if (exitCode === "0") {
      status = parsed.stopReason === "error" || parsed.errorMessage ? "failed" : "done";
    } else if (exitCode && exitCode !== "") {
      status = "failed";
    } else {
      status = parsed.stopReason === "stop" ? "done" : "failed";
    }
  } else if (isAlive) {
    status = "running";
  } else {
    status = "failed";
  }

  const errText = (() => {
    try {
      return fs.readFileSync(paths.err, "utf-8").trim();
    } catch {
      return "";
    }
  })();

  return {
    id: model.id,
    provider: model.provider,
    model: model.model,
    status,
    pid,
    toolCalls: parsed.toolCalls,
    events: parsed.events,
    preview: (parsed.assistantText || parsed.finalText || "").replace(/\n/g, " ").slice(0, 120),
    finalText: parsed.finalText || parsed.assistantText || "",
    errorMessage: parsed.errorMessage || (status === "failed" ? errText.slice(0, 500) || "empty output" : null),
    usage: parsed.usage,
  };
}

export function refreshRun(runDir: string, agents: ModelSpec[]): WorkerState[] {
  return agents.map((a) => refreshWorker(runDir, a));
}
