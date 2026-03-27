import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function getRunsDir(): string {
  return path.join(os.homedir(), ".pi-council", "runs");
}

export function status(runId?: string, json = false): void {
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

  // Check results.json — the ground truth for completed runs
  const resultsPath = path.join(runDir, "results.json");
  if (fs.existsSync(resultsPath)) {
    try {
      const results = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));

      if (json) {
        process.stdout.write(JSON.stringify({ ...results, status: "complete" }, null, 2) + "\n");
        return;
      }

      const totalDuration = Math.max(...(results.members ?? []).map((m: any) => m.durationMs ?? 0));

      process.stdout.write(`Run: ${results.runId}\n`);
      process.stdout.write(`Prompt: "${results.prompt}"\n`);
      process.stdout.write(`Status: complete (${(totalDuration / 1000).toFixed(1)}s)\n\n`);

      for (const m of results.members ?? []) {
        const icon = m.state === "done" ? "✅" : "❌";
        const duration = m.durationMs ? ` (${(m.durationMs / 1000).toFixed(1)}s)` : "";
        const preview = m.output ? ` — ${m.output.slice(0, 80).replace(/\n/g, " ")}...` : "";
        const err = m.error ? ` — ${m.error}` : "";
        process.stdout.write(`${icon} ${m.id}: ${m.state}${duration}${err}${preview}\n`);
      }
    } catch {}
    return;
  }

  // Fall back to meta.json for in-progress runs
  const metaPath = path.join(runDir, "meta.json");
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const elapsed = ((Date.now() - (meta.startedAt ?? Date.now())) / 1000).toFixed(0);
      const models = (meta.models ?? []).map((m: { id: string }) => m.id).join(", ");

      process.stdout.write(`Run: ${meta.runId}\n`);
      process.stdout.write(`Prompt: "${meta.prompt}"\n`);
      process.stdout.write(`Status: in progress (${elapsed}s) [${models}]\n`);
    } catch {}
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
