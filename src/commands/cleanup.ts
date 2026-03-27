import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const RUNS_DIR = path.join(os.homedir(), ".pi-council", "runs");

export function cleanup(runId?: string): void {
  const targetId = runId ?? getLatestRunId();
  if (!targetId) {
    process.stderr.write("No runs found.\n");
    return;
  }

  const runDir = path.join(RUNS_DIR, targetId);
  if (!fs.existsSync(runDir)) {
    process.stderr.write(`Run not found: ${targetId}\n`);
    return;
  }

  fs.rmSync(runDir, { recursive: true, force: true });
  process.stderr.write(`Cleaned up: ${targetId}\n`);
}

export function cancel(runId?: string): void {
  // For CLI cancel, we just remove the run directory
  // The actual process killing happens in the Council class
  cleanup(runId);
}

function getLatestRunId(): string | undefined {
  const latestFile = path.join(os.homedir(), ".pi-council", "latest-run-id");
  try {
    return fs.readFileSync(latestFile, "utf-8").trim();
  } catch {
    if (!fs.existsSync(RUNS_DIR)) return undefined;
    const dirs = fs.readdirSync(RUNS_DIR).sort().reverse();
    return dirs[0];
  }
}
