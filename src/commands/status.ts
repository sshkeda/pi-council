import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, getRunsDir, getLatestFile } from "../core/config.js";
import { loadMeta, refreshRun } from "../core/run-state.js";
import { bold, green, red, yellow, dim } from "../util/format.js";

export function resolveRunId(runId?: string): string {
  let resolved: string;
  if (runId) {
    resolved = runId;
  } else {
    const latestFile = getLatestFile();
    try {
      resolved = fs.readFileSync(latestFile, "utf-8").trim();
    } catch {
      throw new Error("No run specified and no latest run found.");
    }
  }
  // Sanitize: prevent path traversal via malicious run IDs
  if (resolved.includes("..") || resolved.includes("/") || resolved.includes("\\")) {
    throw new Error(`Invalid run ID: ${resolved}`);
  }
  return resolved;
}

export function status(runId?: string): boolean {
  const resolved = resolveRunId(runId);
  const runDir = path.join(getRunsDir(), resolved);
  const meta = loadMeta(runDir);

  if (!meta) {
    process.stderr.write(`No run found: ${resolved}\n`);
    process.exitCode = 1; // Error: run doesn't exist (vs exitCode=2 for "still running")
    return false;
  }

  const config = loadConfig();
  const states = refreshRun(runDir, meta.agents, config.stall_seconds);
  const elapsed = ((Date.now() - meta.startedAt) / 1000).toFixed(0);

  let doneCount = 0;
  let failedCount = 0;

  for (const w of states) {
    const tc = w.toolCalls > 0 ? ` tools:${w.toolCalls}` : "";
    const preview = w.preview ? ` | ${w.preview}...` : "";

    switch (w.status) {
      case "done":
        doneCount++;
        process.stderr.write(`  ${green("✅")} ${bold(w.id.padEnd(8))} done${tc}${preview}\n`);
        break;
      case "failed":
        doneCount++;
        failedCount++;
        process.stderr.write(`  ${red("❌")} ${bold(w.id.padEnd(8))} failed: ${w.errorMessage ?? "unknown"}\n`);
        break;
      case "stalled":
        process.stderr.write(`  ${yellow("⚠️")}  ${bold(w.id.padEnd(8))} stalled${tc}${preview}\n`);
        break;
      case "running":
        process.stderr.write(`  ${yellow("⏳")} ${bold(w.id.padEnd(8))} running${tc}${preview}\n`);
        break;
    }
  }

  process.stderr.write(`\n  ${doneCount}/${states.length} complete, ${failedCount} failed (${elapsed}s elapsed)\n`);

  return states.every((w) => w.status === "done" || w.status === "failed");
}
