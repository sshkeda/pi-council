import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function getRunsDir(): string {
  return path.join(os.homedir(), ".pi-council", "runs");
}

export async function watch(runId?: string): Promise<void> {
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

  const resultsJsonPath = path.join(runDir, "results.json");
  const resultsMdPath = path.join(runDir, "results.md");

  // Already complete?
  if (fs.existsSync(resultsJsonPath)) {
    process.stdout.write(fs.readFileSync(resultsMdPath, "utf-8"));
    return;
  }

  // Read meta for display
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf-8"));
    const models = (meta.models ?? []).map((m: { id: string }) => m.id).join(", ");
    process.stderr.write(`Watching: ${targetId} [${models}]\n`);
  } catch {
    process.stderr.write(`Watching: ${targetId}\n`);
  }

  // Wait for results.json — the ground truth completion artifact
  while (!fs.existsSync(resultsJsonPath)) {
    await new Promise((r) => setTimeout(r, 500));
    process.stderr.write(".");
  }

  process.stderr.write(" done\n\n");
  process.stdout.write(fs.readFileSync(resultsMdPath, "utf-8"));
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
