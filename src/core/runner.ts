import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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

/** Resolve the path to the compiled supervisor script */
function supervisorPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(dir, "supervisor.js");
}

export function spawnWorker(
  runDir: string,
  model: ModelSpec,
  prompt: string,
  config: Config,
  cwd?: string,
  detach = true,
  timeoutSeconds = 0,
): SpawnResult {
  const paths = agentPaths(runDir, model.id);

  const streamFd = fs.openSync(paths.stream, "w");
  const errFd = fs.openSync(paths.err, "w");

  const piArgs = [
    "--mode", "json",
    "-p",
    "--provider", model.provider,
    "--model", model.model,
    "--tools", config.tools,
    "--no-session",
    "--append-system-prompt", config.system_prompt,
    "--",
    prompt,
  ];

  let child: ChildProcess;

  if (detach) {
    // Detached mode: spawn through supervisor.js which handles:
    // 1) Writing .done with real exit code (authoritative completion)
    // 2) Enforcing timeout (kills pi after N seconds)
    // The supervisor spawns pi with inherited stdio, so output goes to our FDs.
    const supervisorArgs = [
      supervisorPath(),
      paths.done,
      String(timeoutSeconds),
      ...piArgs,
    ];

    try {
      child = spawn(process.execPath, supervisorArgs, {
        stdio: ["ignore", streamFd, errFd],
        detached: true,
        cwd: cwd ?? process.cwd(),
        env: { ...process.env },
      });
    } catch (err) {
      fs.closeSync(streamFd);
      fs.closeSync(errFd);
      throw new Error(`Failed to spawn supervisor for model ${model.id}: ${(err as Error).message}`);
    }
  } else {
    // Non-detached mode: spawn pi directly, caller (CouncilSession) manages lifecycle
    try {
      child = spawn("pi", piArgs, {
        stdio: ["ignore", streamFd, errFd],
        detached: false,
        cwd: cwd ?? process.cwd(),
        env: { ...process.env },
      });
    } catch (err) {
      fs.closeSync(streamFd);
      fs.closeSync(errFd);
      throw new Error(`Failed to spawn pi for model ${model.id}: ${(err as Error).message}`);
    }
  }

  if (child.pid === undefined) {
    try { child.kill("SIGTERM"); } catch {}
    fs.closeSync(streamFd);
    fs.closeSync(errFd);
    throw new Error(`Failed to spawn ${detach ? "supervisor" : "pi"} for model ${model.id}: process did not start`);
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
