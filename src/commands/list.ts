import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function getRunsDir(): string {
  return path.join(os.homedir(), ".pi-council", "runs");
}

export function list(json = false): void {
  const runsDir = getRunsDir();

  if (!fs.existsSync(runsDir)) {
    if (json) { process.stdout.write("[]\n"); return; }
    process.stdout.write("No runs found.\n");
    return;
  }

  const dirs = fs.readdirSync(runsDir).sort().reverse();
  if (dirs.length === 0) {
    if (json) { process.stdout.write("[]\n"); return; }
    process.stdout.write("No runs found.\n");
    return;
  }

  if (json) {
    const runs = dirs.map((dir) => {
      const metaPath = path.join(runsDir, dir, "meta.json");
      const resultsPath = path.join(runsDir, dir, "results.json");
      const entry: Record<string, unknown> = { runId: dir, status: fs.existsSync(resultsPath) ? "complete" : "running" };
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        entry.prompt = meta.prompt;
        entry.models = (meta.models ?? []).map((m: { id: string }) => m.id);
        entry.startedAt = meta.startedAt;
      } catch {}
      if (fs.existsSync(resultsPath)) {
        try {
          const results = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
          entry.completedAt = results.completedAt;
          entry.ttfrMs = results.ttfrMs;
        } catch {}
      }
      return entry;
    });
    process.stdout.write(JSON.stringify(runs, null, 2) + "\n");
    return;
  }

  for (const dir of dirs) {
    const metaPath = path.join(runsDir, dir, "meta.json");
    const resultsPath = path.join(runsDir, dir, "results.json");

    let prompt = "?";
    let status = "unknown";
    let models = "";
    let duration = "";

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      prompt = meta.prompt?.slice(0, 60) ?? "?";
      models = (meta.models ?? []).map((m: { id: string }) => m.id).join(", ");
    } catch {}

    if (fs.existsSync(resultsPath)) {
      status = "✅ done";
      try {
        const results = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
        const maxDur = Math.max(...(results.members ?? []).map((m: any) => m.durationMs ?? 0));
        if (maxDur > 0) duration = ` (${(maxDur / 1000).toFixed(1)}s)`;
      } catch {}
    } else {
      status = "🔄 running";
    }

    process.stdout.write(`${dir}  ${status}${duration}  [${models}]  "${prompt}"\n`);
  }
}
