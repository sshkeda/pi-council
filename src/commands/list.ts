import * as fs from "node:fs";
import * as path from "node:path";
import { getRunsDir, getLatestFile, loadConfig } from "../core/config.js";
import { loadMeta, refreshRun } from "../core/run-state.js";
import { bold, dim, green, yellow } from "../util/format.js";

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
  const latest = fs.existsSync(latestFile) ? fs.readFileSync(latestFile, "utf-8").trim() : "";
  const config = loadConfig();

  process.stderr.write(bold("RUN-ID".padEnd(22) + "STATUS".padEnd(12) + "AGENTS".padEnd(10) + "PROMPT") + "\n");
  process.stderr.write("─".repeat(70) + "\n");

  for (const dir of dirs) {
    const runDir = path.join(runsDir, dir);
    const meta = loadMeta(runDir);
    if (!meta) continue;

    const states = refreshRun(runDir, meta.agents, config.stall_seconds);
    const done = states.filter((s) => s.status === "done" || s.status === "failed").length;
    const total = states.length;
    const allDone = done === total;
    const failed = states.filter((s) => s.status === "failed").length;

    const statusStr = allDone
      ? (failed > 0 ? yellow(`${done - failed}/${total} ok`) : green("done"))
      : yellow(`${done}/${total}`);

    const marker = dir === latest ? " ←" : "";
    const promptPreview = meta.prompt.replace(/\n/g, " ").slice(0, 40);

    process.stderr.write(
      `${dim(dir)}${marker}  ${statusStr.padEnd(12)} ${dim(`${total} models`).padEnd(16)} ${promptPreview}\n`,
    );
  }
}
