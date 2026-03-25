import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, getRunsDir } from "../core/config.js";
import { loadMeta, refreshRun, isAgentDone, type WorkerState, type RunMeta } from "../core/run-state.js";
import { resolveRunId } from "./status.js";
import { agentPaths } from "../core/runner.js";
import { dim } from "../util/format.js";

function checkAllDone(runDir: string, meta: RunMeta, _stallSeconds: number): boolean {
  // Fast-path: only check .done files and PID liveness — no JSONL parsing
  return meta.agents.every((a) => isAgentDone(runDir, a));
}

function waitForCompletion(runDir: string, meta: RunMeta, stallSeconds: number): Promise<void> {
  if (checkAllDone(runDir, meta, stallSeconds)) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const watcher = fs.watch(runDir, () => {
      if (checkAllDone(runDir, meta, stallSeconds)) {
        watcher.close();
        clearInterval(pidCheck);
        resolve();
      }
    });

    // PID liveness check every 2s — for background spawn mode
    const pidCheck = setInterval(() => {
      if (checkAllDone(runDir, meta, stallSeconds)) {
        watcher.close();
        clearInterval(pidCheck);
        resolve();
      }
    }, 2_000);

    // Race-proof
    if (checkAllDone(runDir, meta, stallSeconds)) {
      watcher.close();
      clearInterval(pidCheck);
      resolve();
    }
  });
}

export async function results(runId?: string, wait = true): Promise<void> {
  const resolved = resolveRunId(runId);
  const runDir = path.join(getRunsDir(), resolved);
  const meta = loadMeta(runDir);

  if (!meta) {
    process.stderr.write(`No run found: ${resolved}\n`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();

  // Wait for completion via fs.watch + PID checks (event-driven)
  if (wait) {
    await waitForCompletion(runDir, meta, config.stall_seconds);
  }

  // Print results
  const states = refreshRun(runDir, meta.agents, config.stall_seconds);

  let succeeded = 0;
  let failed = 0;

  process.stdout.write("\n");
  for (const w of states) {
    process.stdout.write("═".repeat(60) + "\n");
    process.stdout.write(`## ${w.id.toUpperCase()} (${w.model})\n`);
    process.stdout.write("═".repeat(60) + "\n");

    if (w.finalText) {
      succeeded++;
      process.stdout.write(w.finalText + "\n");
    } else {
      failed++;
      process.stdout.write(`(no output)\nERROR: ${w.errorMessage ?? "empty output"}\n`);
    }

    const u = w.usage;
    if (u.cost > 0) {
      process.stdout.write(dim(`  cost: $${u.cost.toFixed(4)} | tokens: ↑${u.input} ↓${u.output}`) + "\n");
    }
    process.stdout.write("\n");
  }

  process.stderr.write(`${succeeded} succeeded, ${failed} failed\n`);

  // Write results.md
  let md = `# pi-council results\nRun: ${resolved}\n\n`;
  md += `Question:\n${meta.prompt}\n\n---\n\n`;
  for (const w of states) {
    md += `## ${w.id} — ${w.provider}/${w.model}\n\n`;
    md += (w.finalText || `(no output: ${w.errorMessage ?? "unknown"})`) + "\n\n---\n\n";
  }
  fs.writeFileSync(path.join(runDir, "results.md"), md);

  // Write results.json
  const resultsJson = {
    runId: resolved,
    prompt: meta.prompt,
    completedAt: Date.now(),
    workers: states.map((w) => ({
      id: w.id,
      provider: w.provider,
      model: w.model,
      status: w.status,
      finalText: w.finalText,
      errorMessage: w.errorMessage,
      usage: w.usage,
    })),
  };
  fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(resultsJson, null, 2));

  if (failed > 0) process.exitCode = 1;
}
