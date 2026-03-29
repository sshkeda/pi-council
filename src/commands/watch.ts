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

  // Already complete — print and exit
  if (fs.existsSync(resultsJsonPath)) {
    process.stdout.write(fs.readFileSync(resultsMdPath, "utf-8"));
    return;
  }

  // Read meta for model list
  let modelIds: string[] = [];
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf-8"));
    modelIds = (meta.models ?? []).map((m: { id: string }) => m.id);
    const models = modelIds.join(", ");
    process.stderr.write(`Watching: ${targetId} [${models}]\n\n`);
  } catch {
    process.stderr.write(`Watching: ${targetId}\n\n`);
  }

  // Stream per-member results as they appear
  const delivered = new Set<string>();
  const deadline = Date.now() + 600_000; // 10 min max

  while (!fs.existsSync(resultsJsonPath) && Date.now() < deadline) {
    // Check for new per-member JSON files
    for (const id of modelIds) {
      if (delivered.has(id)) continue;
      const memberPath = path.join(runDir, `${id}.json`);
      if (fs.existsSync(memberPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(memberPath, "utf-8"));
          const icon = data.state === "done" ? "✅" : "❌";
          const duration = data.durationMs ? ` (${(data.durationMs / 1000).toFixed(1)}s)` : "";
          process.stdout.write(`## ${icon} ${data.id.toUpperCase()} (${data.model?.model ?? "?"})${duration}\n\n`);
          process.stdout.write(`${data.output || data.error || "(no output)"}\n\n---\n\n`);
          delivered.add(id);
        } catch {
          // File might be partially written — retry next tick
        }
      }
    }

    // Also check for members not in modelIds (discovered dynamically)
    try {
      const files = fs.readdirSync(runDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const id = file.replace(".json", "");
        if (["meta", "results", "prompt"].includes(id)) continue;
        if (delivered.has(id)) continue;
        const memberPath = path.join(runDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(memberPath, "utf-8"));
          if (data.id && data.state) {
            const icon = data.state === "done" ? "✅" : "❌";
            const duration = data.durationMs ? ` (${(data.durationMs / 1000).toFixed(1)}s)` : "";
            process.stdout.write(`## ${icon} ${data.id.toUpperCase()} (${data.model?.model ?? "?"})${duration}\n\n`);
            process.stdout.write(`${data.output || data.error || "(no output)"}\n\n---\n\n`);
            delivered.add(id);
          }
        } catch {}
      }
    } catch {}

    await new Promise((r) => setTimeout(r, 500));
  }

  if (Date.now() >= deadline) {
    process.stderr.write("\nTimed out waiting for results.\n");
    process.exitCode = 1;
    return;
  }

  // Print summary
  if (fs.existsSync(resultsMdPath) && delivered.size === 0) {
    // No streaming happened — print full results
    process.stdout.write(fs.readFileSync(resultsMdPath, "utf-8"));
  } else {
    process.stderr.write(`\nAll ${delivered.size} members done.\n`);
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
