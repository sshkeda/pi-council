import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function getRunsDir(): string { return path.join(os.homedir(), ".pi-council", "runs"); }

export function cleanup(runId?: string): void {
  if (runId === "--all") {
    const runsDir = getRunsDir();
    if (!fs.existsSync(runsDir)) {
      process.stderr.write("No runs found.\n");
      return;
    }
    const dirs = fs.readdirSync(runsDir);
    if (dirs.length === 0) {
      process.stderr.write("No runs found.\n");
      return;
    }
    for (const dir of dirs) {
      fs.rmSync(path.join(runsDir, dir), { recursive: true, force: true });
    }
    process.stderr.write(`Cleaned up ${dirs.length} run(s).\n`);
    return;
  }

  const targetId = runId ?? getLatestRunId();
  if (!targetId) {
    process.stderr.write("No runs found.\n");
    return;
  }

  const runDir = path.join(getRunsDir(), targetId);
  if (!fs.existsSync(runDir)) {
    process.stderr.write(`Run not found: ${targetId}\n`);
    return;
  }

  fs.rmSync(runDir, { recursive: true, force: true });
  process.stderr.write(`Cleaned up: ${targetId}\n`);
}

/**
 * Cancel a run — removes artifacts. Does NOT kill running processes
 * (pi child processes are managed by the `spawn`/`ask` parent process).
 */
export function cancel(runId?: string): void {
  cleanup(runId);
}

function getLatestRunId(): string | undefined {
  const latestFile = path.join(os.homedir(), ".pi-council", "latest-run-id");
  try {
    return fs.readFileSync(latestFile, "utf-8").trim();
  } catch {
    if (!fs.existsSync(getRunsDir())) return undefined;
    const dirs = fs.readdirSync(getRunsDir()).sort().reverse();
    return dirs[0];
  }
}
