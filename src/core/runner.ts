import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { ModelSpec, Config } from "./config.js";

export interface RunPaths {
  stream: string;
  err: string;
  pid: string;
  done: string;
}

export interface SpawnResult {
  pid: number;
  child: ChildProcess;
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
  detach = true,
): SpawnResult {
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
    "--", // end-of-flags: prevents prompt from being parsed as a flag
    prompt,
  ];

  let child: ChildProcess;
  try {
    child = spawn("pi", args, {
      stdio: ["ignore", streamFd, errFd],
      detached: detach,
      cwd: cwd ?? process.cwd(),
      env: { ...process.env },
    });
  } catch (err) {
    fs.closeSync(streamFd);
    fs.closeSync(errFd);
    throw new Error(`Failed to spawn pi for model ${model.id}: ${(err as Error).message}`);
  }

  if (child.pid === undefined) {
    fs.closeSync(streamFd);
    fs.closeSync(errFd);
    throw new Error(`Failed to spawn pi for model ${model.id}: process did not start`);
  }

  const pid = child.pid;
  fs.writeFileSync(paths.pid, String(pid));

  fs.closeSync(streamFd);
  fs.closeSync(errFd);

  if (detach) {
    child.unref();
  }

  return { pid, child };
}
