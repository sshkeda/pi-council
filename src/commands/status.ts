import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function getRunsDir(): string { return path.join(os.homedir(), ".pi-council", "runs"); }

export function status(runId?: string): void {
  const targetId = runId ?? getLatestRunId();
  if (!targetId) {
    process.stderr.write("No runs found.\n");
    process.exitCode = 1;
    return;
  }

  const runDir = path.join(getRunsDir(), targetId);
  if (!fs.existsSync(runDir)) {
    process.stderr.write(`Run not found: ${targetId}\n`);
    process.exitCode = 1;
    return;
  }

  // Check for results.json (completed run)
  const resultsPath = path.join(runDir, "results.json");
  if (fs.existsSync(resultsPath)) {
    const results = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
    process.stdout.write(`Run: ${results.runId}\n`);
    process.stdout.write(`Prompt: "${results.prompt}"\n`);
    process.stdout.write(`Status: complete\n\n`);
    for (const m of results.members) {
      const icon = m.state === "done" ? "✅" : "❌";
      const duration = m.durationMs ? ` (${(m.durationMs / 1000).toFixed(1)}s)` : "";
      process.stdout.write(`${icon} ${m.id}: ${m.state}${duration}\n`);
    }
    return;
  }

  // Check meta.json for in-progress run
  const metaPath = path.join(runDir, "meta.json");
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    process.stdout.write(`Run: ${meta.runId}\n`);
    process.stdout.write(`Prompt: "${meta.prompt}"\n`);
    process.stdout.write(`Status: in progress\n`);
  }
}

function getLatestRunId(): string | undefined {
  const latestFile = path.join(os.homedir(), ".pi-council", "latest-run-id");
  try {
    return fs.readFileSync(latestFile, "utf-8").trim();
  } catch {
    // Fall back to most recent run directory
    if (!fs.existsSync(getRunsDir())) return undefined;
    const dirs = fs.readdirSync(getRunsDir()).sort().reverse();
    return dirs[0];
  }
}
