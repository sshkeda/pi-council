import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, getRunsDir } from "../core/config.js";
import { loadMeta, refreshRun, type WorkerState } from "../core/run-state.js";
import { resolveRunId, status } from "./status.js";
import { bold, dim } from "../util/format.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

  // Wait for completion
  if (wait) {
    let allDone = false;
    while (!allDone) {
      const states = refreshRun(runDir, meta.agents, config.stall_seconds);
      allDone = states.every((w) => w.status === "done" || w.status === "failed");
      if (!allDone) {
        const running = states.filter((w) => w.status === "running" || w.status === "stalled").length;
        process.stderr.write(`\r  Waiting... ${states.length - running}/${states.length} done`);
        await sleep(3000);
      }
    }
    process.stderr.write("\r" + " ".repeat(60) + "\r");
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

    // Usage line
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
