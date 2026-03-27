import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const RUNS_DIR = path.join(os.homedir(), ".pi-council", "runs");

export function list(): void {
  if (!fs.existsSync(RUNS_DIR)) {
    process.stdout.write("No runs found.\n");
    return;
  }

  const dirs = fs.readdirSync(RUNS_DIR).sort().reverse();
  if (dirs.length === 0) {
    process.stdout.write("No runs found.\n");
    return;
  }

  for (const dir of dirs) {
    const metaPath = path.join(RUNS_DIR, dir, "meta.json");
    const resultsPath = path.join(RUNS_DIR, dir, "results.json");

    let prompt = "?";
    let status = "unknown";
    let models = "";

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      prompt = meta.prompt?.slice(0, 60) ?? "?";
      models = (meta.models ?? []).map((m: { id: string }) => m.id).join(", ");
    } catch {}

    if (fs.existsSync(resultsPath)) {
      status = "✅ done";
    } else {
      status = "🔄 running";
    }

    process.stdout.write(`${dir}  ${status}  [${models}]  "${prompt}"\n`);
  }
}
