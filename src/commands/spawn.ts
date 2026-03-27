import { Council, registry } from "../core/council.js";
import { loadConfig } from "../core/config.js";
import { resolveModels } from "../core/profiles.js";
import type { ModelSpec } from "../core/types.js";

export interface SpawnOptions {
  models?: string[];
  cwd?: string;
}

export function spawn(prompt: string, opts: SpawnOptions = {}): void {
  const config = loadConfig();
  let models: ModelSpec[] = config.models;
  if (opts.models && opts.models.length > 0) {
    models = resolveModels(config.models, opts.models);
    if (models.length === 0) {
      throw new Error("No matching models found.");
    }
  }

  const council = new Council(prompt);
  registry.add(council);

  const spawnOpts: Record<string, unknown> = { models, cwd: opts.cwd };
  if (config.systemPrompt) {
    spawnOpts.systemPrompt = config.systemPrompt;
  }
  if (process.env.PI_COUNCIL_PI_BINARY) {
    spawnOpts.piBinary = "node";
    spawnOpts.piBinaryArgs = [process.env.PI_COUNCIL_PI_BINARY];
  }
  council.spawn(spawnOpts as any);

  const modelNames = models.map((m) => m.id).join(", ");
  process.stdout.write(`${council.runId}\n`);
  process.stderr.write(`Spawned: ${modelNames} (run: ${council.runId})\n`);
}
