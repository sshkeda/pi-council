import * as fs from "node:fs";
import * as path from "node:path";
import { getRunsDir, getLatestFile } from "../core/config.js";
import { loadMeta } from "../core/run-state.js";
import { killAllAgents } from "../core/run-lifecycle.js";
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

  killAllAgents(runDir, meta.agents, true);
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

  killAllAgents(runDir, meta.agents, false);

  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`  ⚠️  Failed to remove run directory: ${(err as Error).message}\n`);
  }

  const latestFile = getLatestFile();
  try {
    const latest = fs.readFileSync(latestFile, "utf-8").trim();
    if (latest === resolved) {
      const runsDir = getRunsDir();
      const remaining = fs.existsSync(runsDir)
        ? fs.readdirSync(runsDir).filter((d) => d !== resolved).sort().reverse()
        : [];
      if (remaining.length > 0) {
        fs.writeFileSync(latestFile, remaining[0]);
      } else {
        fs.unlinkSync(latestFile);
      }
    }
  } catch {
    // latest-run-id missing or unreadable — not critical
  }

  process.stderr.write(`Cleaned up: ${resolved}\n`);
}
