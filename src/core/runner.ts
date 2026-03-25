import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ModelSpec, Config } from "./config.js";

export interface RunPaths {
  stream: string;
  err: string;
  pid: string;
  done: string;
}

export function agentPaths(runDir: string, id: string): RunPaths {
  return {
    stream: path.join(runDir, `${id}.jsonl`),
    err: path.join(runDir, `${id}.err`),
    pid: path.join(runDir, `${id}.pid`),
    done: path.join(runDir, `${id}.done`),
  };
}

export function spawnWorker(
  runDir: string,
  model: ModelSpec,
  prompt: string,
  config: Config,
  cwd?: string,
): number {
  const paths = agentPaths(runDir, model.id);

  const streamFd = fs.openSync(paths.stream, "w");
  const errFd = fs.openSync(paths.err, "w");

  const args = [
    "--mode", "json",
    "-p",
    "--provider", model.provider,
    "--model", model.model,
    "--tools", config.tools,
    "--no-session",
    "--append-system-prompt", config.system_prompt,
    prompt,
  ];

  const child = spawn("pi", args, {
    stdio: ["ignore", streamFd, errFd],
    detached: true,
    cwd: cwd ?? process.cwd(),
    env: { ...process.env },
  });

  const pid = child.pid!;
  fs.writeFileSync(paths.pid, String(pid));

  // Close fds and detach
  fs.closeSync(streamFd);
  fs.closeSync(errFd);
  child.unref();

  return pid;
}
