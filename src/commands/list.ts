import * as fs from "node:fs";
import * as path from "node:path";
import { getRunsDir, getLatestFile, loadConfig } from "../core/config.js";
import { loadMeta, refreshRun, type WorkerState } from "../core/run-state.js";
import { bold, dim, green, yellow } from "../util/format.js";

/** Compute a human-readable status string from worker states. Pads BEFORE colorizing to avoid ANSI-aware padding issues. */
function computeStatusStr(total: number, doneCount: number, failedCount: number): string {
  if (doneCount === total) {
    const raw = failedCount > 0 ? `${total - failedCount}/${total} ok` : "done";
    return failedCount > 0 ? yellow(raw.padEnd(10)) : green(raw.padEnd(10));
  }
  const raw = `${doneCount}/${total}`;
  return yellow(raw.padEnd(10));
}

export function list(): void {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) {
    process.stderr.write("No runs found.\n");
    return;
  }

  const dirs = fs.readdirSync(runsDir).sort().reverse();
  if (dirs.length === 0) {
    process.stderr.write("No runs found.\n");
    return;
  }

  const latestFile = getLatestFile();
  let latest = "";
  try { latest = fs.readFileSync(latestFile, "utf-8").trim(); } catch {}
  const config = loadConfig();

  process.stderr.write(bold("RUN-ID".padEnd(22) + "STATUS".padEnd(12) + "AGENTS".padEnd(10) + "PROMPT") + "\n");
  process.stderr.write("─".repeat(70) + "\n");

  for (const dir of dirs) {
    const runDir = path.join(runsDir, dir);
    const meta = loadMeta(runDir);
    if (!meta) continue;

    let statusStr: string;
    let total: number;

    // Fast-path: use results.json for completed runs (avoids re-parsing all JSONL streams)
    const resultsPath = path.join(runDir, "results.json");
    try {
      const resultsJson = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
      const workers: Array<{ status: string }> = resultsJson.workers ?? [];
      total = workers.length;
      const failed = workers.filter((w) => w.status !== "done").length;
      statusStr = computeStatusStr(total, total, failed);
    } catch {
      // No results.json or corrupted — refresh from live state
      const states = refreshRun(runDir, meta.agents, config.stall_seconds);
      total = states.length;
      const done = states.filter((s) => s.status === "done" || s.status === "failed").length;
      const failed = states.filter((s) => s.status === "failed").length;
      statusStr = computeStatusStr(total, done, failed);
    }

    const marker = dir === latest ? " ←" : "";
    const promptPreview = meta.prompt.replace(/\n/g, " ").slice(0, 40);

    process.stderr.write(
      `${dim(dir)}${marker}  ${statusStr} ${dim(`${total} models`.padEnd(12))} ${promptPreview}\n`,
    );
  }
}
