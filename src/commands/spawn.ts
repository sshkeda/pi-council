import { loadConfig, resolveModels } from "../core/config.js";
import { spawnWorker } from "../core/runner.js";
import { createRun } from "../core/run-lifecycle.js";

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

  const { runId, runDir } = createRun(prompt, models, opts.cwd ?? process.cwd());

  // Spawn workers (detached for background mode)
  for (const model of models) {
    const { pid } = spawnWorker(runDir, model, prompt, config, opts.cwd, true);
    process.stderr.write(`  🚀 ${model.id.padEnd(8)} spawned (PID ${pid}, ${model.model})\n`);
  }

  process.stderr.write(`\n🏛️  Council spawned (${models.length} models, run: ${runId})\n`);
  process.stderr.write(`   status  : pi-council status ${runId}\n`);
  process.stderr.write(`   results : pi-council results ${runId}\n`);
  process.stderr.write(`   cleanup : pi-council cleanup ${runId}\n`);

  // Print run-id to stdout (machine-readable)
  process.stdout.write(runId + "\n");

  return runId;
}
