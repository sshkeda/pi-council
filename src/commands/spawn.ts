import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, resolveModels, getRunsDir, getLatestFile } from "../core/config.js";
import { spawnWorker } from "../core/runner.js";
import { generateRunId } from "../util/run-id.js";
import type { RunMeta } from "../core/run-state.js";

export interface SpawnOptions {
  models?: string[];
  cwd?: string;
}

export function spawn(prompt: string, opts: SpawnOptions = {}): string {
  const config = loadConfig();
  const models = resolveModels(config, opts.models);

  if (models.length === 0) {
    throw new Error("No models selected. Check your config or --models flag.");
  }

  const runId = generateRunId();
  const runDir = path.join(getRunsDir(), runId);
  fs.mkdirSync(runDir, { recursive: true });

  // Write prompt
  fs.writeFileSync(path.join(runDir, "prompt.txt"), prompt);

  // Write meta
  const meta: RunMeta = {
    runId,
    prompt,
    startedAt: Date.now(),
    agents: models,
    cwd: opts.cwd ?? process.cwd(),
  };
  fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta, null, 2));

  // Spawn workers (detached for background mode)
  for (const model of models) {
    const { pid } = spawnWorker(runDir, model, prompt, config, opts.cwd, true);
    process.stderr.write(`  🚀 ${model.id.padEnd(8)} spawned (PID ${pid}, ${model.model})\n`);
  }

  // Write latest
  fs.writeFileSync(getLatestFile(), runId);

  process.stderr.write(`\n🏛️  Council spawned (${models.length} models, run: ${runId})\n`);
  process.stderr.write(`   status  : pi-council status ${runId}\n`);
  process.stderr.write(`   results : pi-council results ${runId}\n`);
  process.stderr.write(`   cleanup : pi-council cleanup ${runId}\n`);

  // Print run-id to stdout (machine-readable)
  process.stdout.write(runId + "\n");

  return runId;
}
