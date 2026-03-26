import * as fs from "node:fs";
import { loadConfig, resolveModels } from "../core/config.js";
import { spawnWorker, agentPaths } from "../core/runner.js";
import { createRun } from "../core/run-lifecycle.js";
import { killPid } from "../util/pid.js";

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
  const spawnedPids: number[] = [];
  for (const model of models) {
    try {
      const { pid } = spawnWorker(runDir, model, prompt, config, opts.cwd, true, config.timeout_seconds);
      spawnedPids.push(pid);
      process.stderr.write(`  🚀 ${model.id.padEnd(8)} spawned (PID ${pid}, ${model.model})\n`);
    } catch (err) {
      // Kill already-spawned workers and write .done for all agents
      process.stderr.write(`  ❌ ${model.id.padEnd(8)} spawn failed: ${(err as Error).message}\n`);
      for (const pid of spawnedPids) { killPid(pid); }
      // Write .done markers for all agents so results/watch don't hang
      for (const m of models) {
        const p = agentPaths(runDir, m.id);
        try { fs.accessSync(p.done); } catch {
          try { fs.writeFileSync(p.done, "1"); } catch {}
        }
      }
      throw err;
    }
  }

  process.stderr.write(`\n🏛️  Council spawned (${models.length} models, run: ${runId})\n`);
  process.stderr.write(`   status  : pi-council status ${runId}\n`);
  process.stderr.write(`   results : pi-council results ${runId}\n`);
  process.stderr.write(`   cleanup : pi-council cleanup ${runId}\n`);

  // Print run-id to stdout (machine-readable)
  process.stdout.write(runId + "\n");

  return runId;
}
