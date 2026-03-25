import * as fs from "node:fs";
import * as path from "node:path";
import { getRunsDir, getLatestFile } from "../core/config.js";
import { loadMeta } from "../core/run-state.js";
import { agentPaths } from "../core/runner.js";
import { killPid } from "../util/pid.js";
import { resolveRunId } from "./status.js";

/** Kill workers but keep files for inspection */
export function cancel(runId?: string): void {
  const resolved = resolveRunId(runId);
  const runDir = path.join(getRunsDir(), resolved);
  const meta = loadMeta(runDir);

  if (!meta) {
    process.stderr.write(`No run found: ${resolved}\n`);
    process.exitCode = 1;
    return;
  }

  for (const agent of meta.agents) {
    const paths = agentPaths(runDir, agent.id);
    if (fs.existsSync(paths.pid)) {
      try {
        const pid = parseInt(fs.readFileSync(paths.pid, "utf-8").trim(), 10);
        killPid(pid);
      } catch {}
    }
    // Write .done so status/results can read partial output
    if (!fs.existsSync(paths.done)) {
      try { fs.writeFileSync(paths.done, "cancelled"); } catch {}
    }
  }

  process.stderr.write(`Cancelled: ${resolved} (files kept — use status/results to inspect)\n`);
}

/** Kill workers AND delete run directory */
export function cleanup(runId?: string): void {
  const resolved = resolveRunId(runId);
  const runDir = path.join(getRunsDir(), resolved);
  const meta = loadMeta(runDir);

  if (!meta) {
    process.stderr.write(`No run found: ${resolved}\n`);
    process.exitCode = 1;
    return;
  }

  for (const agent of meta.agents) {
    const paths = agentPaths(runDir, agent.id);
    if (fs.existsSync(paths.pid)) {
      try {
        const pid = parseInt(fs.readFileSync(paths.pid, "utf-8").trim(), 10);
        killPid(pid);
      } catch {}
    }
  }

  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch {}

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
