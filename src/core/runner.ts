import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type { ModelSpec, Config } from "./config.js";

export interface RunPaths { stream: string; err: string; pid: string; done: string; }
export interface SpawnResult { pid: number; child: ChildProcess; }

export function agentPaths(runDir: string, id: string): RunPaths {
  return {
    stream: path.join(runDir, `${id}.jsonl`),
    err: path.join(runDir, `${id}.err`),
    pid: path.join(runDir, `${id}.pid`),
    done: path.join(runDir, `${id}.done`),
  };
}

function supervisorPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "supervisor.js");
}

export function spawnWorker(runDir: string, model: ModelSpec, prompt: string, config: Config, cwd?: string, detach = true, timeoutSeconds = 0): SpawnResult {
  const paths = agentPaths(runDir, model.id);
  const streamFd = fs.openSync(paths.stream, "w");
  const errFd = fs.openSync(paths.err, "w");

  const piArgs = ["--mode", "json", "-p", "--provider", model.provider, "--model", model.model, "--tools", config.tools, "--no-session", "--append-system-prompt", config.system_prompt, "--", prompt];

  let child: ChildProcess;
  try {
    if (detach) {
      child = spawn(process.execPath, [supervisorPath(), paths.done, String(timeoutSeconds), ...piArgs], {
        stdio: ["ignore", streamFd, errFd], detached: true, cwd: cwd ?? process.cwd(), env: { ...process.env },
      });
    } else {
      child = spawn("pi", piArgs, {
        stdio: ["ignore", streamFd, errFd], detached: false, cwd: cwd ?? process.cwd(), env: { ...process.env },
      });
    }
  } catch (err) {
    fs.closeSync(streamFd); fs.closeSync(errFd);
    throw new Error(`Failed to spawn for ${model.id}: ${(err as Error).message}`);
  }

  if (child.pid === undefined) {
    try { child.kill("SIGTERM"); } catch {}
    fs.closeSync(streamFd); fs.closeSync(errFd);
    throw new Error(`Failed to spawn for ${model.id}: process did not start`);
  }

  fs.writeFileSync(paths.pid, String(child.pid));
  fs.closeSync(streamFd); fs.closeSync(errFd);
  if (detach) child.unref();
  return { pid: child.pid, child };
}

// --- Stream parser ---

export interface ParsedStream {
  assistantText: string;
  finalText: string;
  stopReason: string | null;
  errorMessage: string | null;
  toolCalls: number;
  events: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

export function parseStream(filePath: string): ParsedStream {
  const result: ParsedStream = {
    assistantText: "", finalText: "", stopReason: null, errorMessage: null, toolCalls: 0, events: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  };
  let raw: string;
  try { raw = fs.readFileSync(filePath, "utf-8"); } catch { return result; }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: { type?: string; message?: Record<string, unknown> };
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (!event || typeof event.type !== "string") continue;
    result.events++;

    const msg = event.message as Record<string, unknown> | undefined;
    if (!msg || msg.role !== "assistant") continue;
    const content = (msg.content ?? []) as Array<{ type: string; text?: string }>;
    const texts = content.filter(p => p.type === "text").map(p => p.text ?? "");
    const joined = texts.join("").trim();

    if (event.type === "message_update") {
      if (joined) result.assistantText = joined;
    } else if (event.type === "message_end") {
      result.toolCalls += content.filter(p => p.type === "toolCall").length;
      const stop = (msg.stopReason as string) ?? null;
      if (stop === "stop" && joined) { result.finalText = joined; result.assistantText = joined; }
      if (joined) result.assistantText = joined;
      result.stopReason = stop;
      result.errorMessage = (msg.errorMessage as string) ?? null;
      const u = msg.usage as Record<string, unknown> | undefined;
      if (u) {
        result.usage.input += (u.input as number) ?? 0;
        result.usage.output += (u.output as number) ?? 0;
        result.usage.cacheRead += (u.cacheRead as number) ?? 0;
        result.usage.cacheWrite += (u.cacheWrite as number) ?? 0;
        result.usage.cost += ((u.cost as Record<string, number>)?.total) ?? 0;
      }
    }
  }
  return result;
}
