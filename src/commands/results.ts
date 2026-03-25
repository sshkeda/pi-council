import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, getRunsDir } from "../core/config.js";
import { loadMeta, refreshRun, type WorkerState } from "../core/run-state.js";
import { resolveRunId } from "./status.js";
import { agentPaths } from "../core/runner.js";
import { dim } from "../util/format.js";

function waitForCompletion(runDir: string, agentIds: string[]): Promise<void> {
  // Check if already done
  const allDone = agentIds.every((id) => fs.existsSync(agentPaths(runDir, id).done));
  if (allDone) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const watcher = fs.watch(runDir, () => {
      // On any fs event, check if all .done files exist
      const done = agentIds.every((id) => fs.existsSync(agentPaths(runDir, id).done));
      if (done) {
        watcher.close();
        clearInterval(safety);
        resolve();
      }
    });

    // Safety fallback every 30s in case fs.watch misses events
    const safety = setInterval(() => {
      const done = agentIds.every((id) => fs.existsSync(agentPaths(runDir, id).done));
      if (done) {
        watcher.close();
        clearInterval(safety);
        resolve();
      }
    }, 30_000);

    // Race-proof: file may appear between initial check and fs.watch setup
    const done = agentIds.every((id) => fs.existsSync(agentPaths(runDir, id).done));
    if (done) {
      watcher.close();
      clearInterval(safety);
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

  // Wait for completion via fs.watch (event-driven, not polling)
  if (wait) {
    const agentIds = meta.agents.map((a) => a.id);
    await waitForCompletion(runDir, agentIds);
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
