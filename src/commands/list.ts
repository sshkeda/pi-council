import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function getRunsDir(): string {
  return path.join(os.homedir(), ".pi-council", "runs");
}

export function list(): void {
  const runsDir = getRunsDir();

  if (!fs.existsSync(runsDir)) {
    process.stdout.write("No runs found.\n");
    return;
  }

  const dirs = fs.readdirSync(runsDir).sort().reverse();
  if (dirs.length === 0) {
    process.stdout.write("No runs found.\n");
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
