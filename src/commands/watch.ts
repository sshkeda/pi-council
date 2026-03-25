import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, getRunsDir } from "../core/config.js";
import { loadMeta, refreshWorker, type RunMeta } from "../core/run-state.js";
import { agentPaths } from "../core/runner.js";
import { resolveRunId } from "./status.js";
import { bold, green, red, yellow, dim } from "../util/format.js";

const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Watch a council run — prints each agent's result the instant it finishes.
 * Auto-exits after timeout so the orchestrator can check on haywire agents.
 */
export async function watch(runId?: string, timeoutSeconds?: number): Promise<void> {
  const resolved = resolveRunId(runId);
  const runDir = path.join(getRunsDir(), resolved);
  const meta = loadMeta(runDir);

  if (!meta) {
    process.stderr.write(`No run found: ${resolved}\n`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const timeout = timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const remaining = new Set(meta.agents.map((a) => a.id));

  checkAndPrint(runDir, meta, config.stall_seconds, remaining);

  if (remaining.size === 0) {
    process.stderr.write(dim("All agents already finished.\n"));
    return;
  }

  process.stderr.write(dim(`Watching ${remaining.size} remaining agent(s) (${timeout}s timeout)...\n\n`));

  return new Promise<void>((resolve) => {
    const deadline = setTimeout(() => {
      watcher.close();
      clearInterval(pidCheck);
      // Print status of whatever's still running
      for (const id of remaining) {
        const agent = meta.agents.find((a) => a.id === id);
        if (!agent) continue;
        const w = refreshWorker(runDir, agent, config.stall_seconds);
        const preview = w.preview ? ` | ${w.preview}...` : "";
        process.stderr.write(`  ${yellow("⏳")} ${bold(w.id.padEnd(8))} still running (${w.toolCalls} tool calls)${preview}\n`);
      }
      process.stderr.write(dim(`\nTimeout after ${timeout}s. ${remaining.size} agent(s) still running.\n`));
      process.stderr.write(dim(`  status  : pi-council status ${resolved}\n`));
      process.stderr.write(dim(`  watch   : pi-council watch ${resolved}\n`));
      process.stderr.write(dim(`  cleanup : pi-council cleanup ${resolved}\n`));
      resolve();
    }, timeout * 1000);

    const watcher = fs.watch(runDir, () => {
      checkAndPrint(runDir, meta, config.stall_seconds, remaining);
      if (remaining.size === 0) {
        clearTimeout(deadline);
        watcher.close();
        clearInterval(pidCheck);
        resolve();
      }
    });

    const pidCheck = setInterval(() => {
      checkAndPrint(runDir, meta, config.stall_seconds, remaining);
      if (remaining.size === 0) {
        clearTimeout(deadline);
        watcher.close();
        clearInterval(pidCheck);
        resolve();
      }
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
