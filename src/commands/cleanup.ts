import * as fs from "node:fs";
import * as path from "node:path";
import { getRunsDir, getLatestFile } from "../core/config.js";
import { loadMeta } from "../core/run-state.js";
import { agentPaths } from "../core/runner.js";
import { killPid } from "../util/pid.js";
import { resolveRunId } from "./status.js";

export function cleanup(runId?: string): void {
  const resolved = resolveRunId(runId);
  const runDir = path.join(getRunsDir(), resolved);
  const meta = loadMeta(runDir);

  if (!meta) {
    process.stderr.write(`No run found: ${resolved}\n`);
    process.exitCode = 1;
    return;
  }

  // Kill all workers synchronously
  for (const agent of meta.agents) {
    const paths = agentPaths(runDir, agent.id);
    if (fs.existsSync(paths.pid)) {
      try {
        const pid = parseInt(fs.readFileSync(paths.pid, "utf-8").trim(), 10);
        killPid(pid); // synchronous kill with SIGKILL fallback
      } catch {
        // ignore
      }
    }
  }

  // Remove run dir
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  // Update latest if it pointed here
  const latestFile = getLatestFile();
  if (fs.existsSync(latestFile)) {
    const latest = fs.readFileSync(latestFile, "utf-8").trim();
    if (latest === resolved) {
      const runsDir = getRunsDir();
      const remaining = fs.existsSync(runsDir)
        ? fs.readdirSync(runsDir).filter((d) => d !== resolved).sort().reverse()
        : [];
      if (remaining.length > 0) {
        fs.writeFileSync(latestFile, remaining[0]);
      } else {
        try { fs.unlinkSync(latestFile); } catch {}
      }
    }
  }

  process.stderr.write(`Cleaned up: ${resolved}\n`);
}
