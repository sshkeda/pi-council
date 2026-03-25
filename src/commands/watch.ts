import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, getRunsDir } from "../core/config.js";
import { loadMeta, refreshWorker } from "../core/run-state.js";
import { agentPaths } from "../core/runner.js";
import { resolveRunId } from "./status.js";
import { bold, green, red, yellow, dim } from "../util/format.js";

/**
 * Watch a council run — prints each agent's result the instant it finishes.
 * Event-driven via fs.watch, zero polling.
 * Orchestrator can call this after doing foreground work to catch up on everything.
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

  // Print anything already done
  for (const agent of meta.agents) {
    const paths = agentPaths(runDir, agent.id);
    if (fs.existsSync(paths.done)) {
      printAgentResult(runDir, agent.id, config.stall_seconds, meta);
      remaining.delete(agent.id);
    }
  }

  if (remaining.size === 0) {
    process.stderr.write(dim("\nAll agents already finished.\n"));
    return;
  }

  process.stderr.write(dim(`\nWatching ${remaining.size} remaining agent(s)...\n\n`));

  // Watch for .done files — event-driven
  return new Promise<void>((resolve) => {
    const watcher = fs.watch(runDir, (_, filename) => {
      if (!filename?.endsWith(".done")) return;
      const id = filename.replace(".done", "");
      if (!remaining.has(id)) return;

      remaining.delete(id);
      printAgentResult(runDir, id, config.stall_seconds, meta);

      if (remaining.size === 0) {
        watcher.close();
        clearInterval(safety);
        resolve();
      }
    });

    // 30s safety fallback
    const safety = setInterval(() => {
      for (const id of [...remaining]) {
        if (fs.existsSync(agentPaths(runDir, id).done)) {
          remaining.delete(id);
          printAgentResult(runDir, id, config.stall_seconds, meta);
        }
      }
      if (remaining.size === 0) {
        watcher.close();
        clearInterval(safety);
        resolve();
      }
    }, 30_000);

    // Race-proof
    for (const id of [...remaining]) {
      if (fs.existsSync(agentPaths(runDir, id).done)) {
        remaining.delete(id);
        printAgentResult(runDir, id, config.stall_seconds, meta);
      }
    }
    if (remaining.size === 0) {
      watcher.close();
      clearInterval(safety);
      resolve();
    }
  });
}

function printAgentResult(
  runDir: string,
  id: string,
  stallSeconds: number,
  meta: import("../core/run-state.js").RunMeta,
): void {
  const agent = meta.agents.find((a) => a.id === id);
  if (!agent) return;

  const w = refreshWorker(runDir, agent, stallSeconds);
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
