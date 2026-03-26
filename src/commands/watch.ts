import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, getRunsDir } from "../core/config.js";
import { loadMeta, refreshWorker, isAgentDone, type RunMeta } from "../core/run-state.js";
import { resolveRunId } from "./status.js";
import { bold, green, red, dim } from "../util/format.js";

/**
 * Watch a council run — prints each agent's result the instant it finishes.
 * Uses fs.watch + PID liveness checks. No timeout — agents handle their own limits.
 */
export async function watch(runId?: string): Promise<void> {
  const resolved = resolveRunId(runId);
  const runDir = path.join(getRunsDir(), resolved);
  const meta = loadMeta(runDir);

  if (!meta) {
    process.stderr.write(`No run found: ${resolved}\n`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const remaining = new Set(meta.agents.map((a) => a.id));

  checkAndPrint(runDir, meta, config.stall_seconds, remaining);

  if (remaining.size === 0) {
    process.stderr.write(dim("All agents already finished.\n"));
    return;
  }

  process.stderr.write(dim(`Watching ${remaining.size} remaining agent(s)...\n\n`));

  return new Promise<void>((resolve) => {
    let watcher: fs.FSWatcher | null = null;
    let pidCheck: ReturnType<typeof setInterval> | null = null;

    const done = () => {
      if (watcher) { watcher.close(); watcher = null; }
      if (pidCheck) { clearInterval(pidCheck); pidCheck = null; }
      process.removeListener("SIGINT", onSigint);
      resolve();
    };

    const onSigint = () => { process.exitCode = 130; done(); };
    process.once("SIGINT", onSigint);

    try {
      watcher = fs.watch(runDir, () => {
        checkAndPrint(runDir, meta, config.stall_seconds, remaining);
        if (remaining.size === 0) done();
      });

      watcher.on("error", () => {
        // Watcher failed — polling fallback below will handle it
        if (watcher) { watcher.close(); watcher = null; }
      });
    } catch {
      // fs.watch unavailable — rely entirely on polling fallback below
    }

    pidCheck = setInterval(() => {
      checkAndPrint(runDir, meta, config.stall_seconds, remaining);
      if (remaining.size === 0) done();
    }, 2_000);
  });
}

function checkAndPrint(
  runDir: string,
  meta: RunMeta,
  stallSeconds: number,
  remaining: Set<string>,
): void {
  for (const id of [...remaining]) {
    const agent = meta.agents.find((a) => a.id === id);
    if (!agent) { remaining.delete(id); continue; }

    // Fast-path: skip expensive JSONL parsing unless the agent is actually done
    if (!isAgentDone(runDir, agent)) continue;

    const w = refreshWorker(runDir, agent, stallSeconds);

    if (w.status === "done" || w.status === "failed") {
      remaining.delete(id);
      const icon = w.status === "done" ? green("✅") : red("❌");
      process.stdout.write(`${icon} ${bold(w.id.toUpperCase())} (${w.model})\n`);
      if (w.finalText) {
        process.stdout.write(w.finalText + "\n");
      } else {
        process.stdout.write(`(no output: ${w.errorMessage ?? "unknown"})\n`);
      }
      if (w.usage.cost > 0) {
        process.stdout.write(dim(`  cost: $${w.usage.cost.toFixed(4)} | tokens: ↑${w.usage.input} ↓${w.usage.output}`) + "\n");
      }
      process.stdout.write("\n");
    }
  }
}
