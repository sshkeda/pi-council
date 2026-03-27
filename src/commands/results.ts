import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function getRunsDir(): string { return path.join(os.homedir(), ".pi-council", "runs"); }

export async function results(runId?: string): Promise<void> {
  const targetId = runId ?? getLatestRunId();
  if (!targetId) {
    process.stderr.write("No runs found.\n");
    process.exitCode = 1;
    return;
  }

  const runDir = path.join(getRunsDir(), targetId);
  const mdPath = path.join(runDir, "results.md");

  // Wait for results if not yet available
  if (!fs.existsSync(mdPath)) {
    process.stderr.write(`Waiting for results (${targetId})...\n`);
    await waitForFile(mdPath, 600_000);
  }

  if (fs.existsSync(mdPath)) {
    process.stdout.write(fs.readFileSync(mdPath, "utf-8"));
  } else {
    process.stderr.write("Results not available.\n");
    process.exitCode = 1;
  }
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

function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (fs.existsSync(filePath) || Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve();
      }
    }, 500);
  });
}
