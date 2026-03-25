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
    return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as RunMeta;
  } catch {
    // Corrupted or partially-written meta.json — treat as missing
    return null;
  }
}

/**
 * Write a .done marker file. Logs to stderr on failure instead of swallowing.
 */
function writeDoneMarker(donePath: string, content: string): void {
  try {
    fs.writeFileSync(donePath, content);
  } catch (err) {
    process.stderr.write(`⚠️  Failed to write .done marker (${donePath}): ${(err as Error).message}\n`);
  }
}

/**
 * Parse a PID from a .pid file. Returns null if file is missing, empty, or contains invalid data.
 */
function readPid(pidPath: string): number | null {
  if (!fs.existsSync(pidPath)) return null;
  try {
    const raw = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
    return Number.isFinite(raw) ? raw : null;
  } catch {
    // File may have been removed between existsSync and read — race condition, not actionable
    return null;
  }
}

/**
 * Fast check: is this agent finished? Only checks .done file and PID liveness.
 * Does NOT parse the JSONL stream — use for watch/results polling loops.
 * Side-effect: writes .done marker if PID is dead but no .done file exists.
 */
export function isAgentDone(runDir: string, model: ModelSpec): boolean {
  const paths = agentPaths(runDir, model.id);
  if (fs.existsSync(paths.done)) return true;

  // Check PID liveness
  const pid = readPid(paths.pid);
  if (pid !== null && !pidAlive(pid)) {
    // Process exited without writing .done — mark done (side-effect isolated here)
    writeDoneMarker(paths.done, "");
    return true;
  }

  return false;
}

export function refreshWorker(runDir: string, model: ModelSpec, stallSeconds: number): WorkerState {
  const paths = agentPaths(runDir, model.id);
  const parsed = parseStream(paths.stream);

  const pid = readPid(paths.pid);
  const isDone = fs.existsSync(paths.done);
  const isAlive = pid !== null && pidAlive(pid);

  // Mark done if process exited (isolated side-effect)
  if (!isDone && pid !== null && !isAlive) {
    writeDoneMarker(paths.done, "");
  }

  // Read exit code from .done file to determine success vs failure
  let exitCode: string | null = null;
  if (isDone) {
    try {
      exitCode = fs.readFileSync(paths.done, "utf-8").trim();
    } catch {
      // .done file disappeared between check and read — treat as unknown exit
      exitCode = null;
    }
  }

  let status: WorkerStatus;
  if (isDone || (!isAlive && pid !== null)) {
    // Use exit code when available: "0" = success, anything else = failure
    // "cancelled" is also treated as failure
    if (exitCode === "0") {
      status = "done";
    } else if (exitCode && exitCode !== "" && exitCode !== "0") {
      // Explicit non-zero exit code or "cancelled" — failed even if there's partial text
      status = "failed";
    } else {
      // No explicit exit code (empty .done file from PID death detection) — fall back to text check
      status = parsed.finalText || parsed.assistantText ? "done" : "failed";
    }
  } else if (isAlive) {
    // Check stall: compare file mtimes against stall_seconds threshold
    let lastMtime = 0;
    for (const p of [paths.stream, paths.err]) {
      try {
        const mtime = fs.statSync(p).mtimeMs;
        if (mtime > lastMtime) lastMtime = mtime;
      } catch {
        // File may not exist yet if agent just started — ignore
      }
    }
    const age = (Date.now() - lastMtime) / 1000;
    status = age > stallSeconds ? "stalled" : "running";
  } else {
    status = "failed";
  }

  const errText = (() => {
    try {
      return fs.existsSync(paths.err) ? fs.readFileSync(paths.err, "utf-8").trim() : "";
    } catch {
      // .err file may have been removed — not critical
      return "";
    }
  })();

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
