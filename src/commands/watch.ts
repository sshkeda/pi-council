import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const RUNS_DIR = path.join(os.homedir(), ".pi-council", "runs");

export async function watch(runId?: string): Promise<void> {
  const targetId = runId ?? getLatestRunId();
  if (!targetId) {
    process.stderr.write("No runs found.\n");
    process.exitCode = 1;
    return;
  }

  const runDir = path.join(RUNS_DIR, targetId);
  const resultsPath = path.join(runDir, "results.md");

  process.stderr.write(`Watching: ${targetId}\n`);

  // Poll for results
  while (!fs.existsSync(resultsPath)) {
    await new Promise((r) => setTimeout(r, 1000));
    process.stderr.write(".");
  }

  process.stderr.write("\n\n");
  process.stdout.write(fs.readFileSync(resultsPath, "utf-8"));
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
