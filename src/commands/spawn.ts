import { Council, registry } from "../core/council.js";
import { DEFAULT_MODELS, resolveModels } from "../core/profiles.js";
import type { ModelSpec } from "../core/types.js";

export interface SpawnOptions {
  models?: string[];
  cwd?: string;
}

export function spawn(prompt: string, opts: SpawnOptions = {}): void {
  let models: ModelSpec[] = DEFAULT_MODELS;
  if (opts.models && opts.models.length > 0) {
    models = resolveModels(DEFAULT_MODELS, opts.models);
    if (models.length === 0) {
      throw new Error("No matching models found.");
    }
  }

  const council = new Council(prompt);
  registry.add(council);

  council.spawn({ models, cwd: opts.cwd });

  const modelNames = models.map((m) => m.id).join(", ");
  process.stdout.write(`${council.runId}\n`);
  process.stderr.write(`Spawned: ${modelNames} (run: ${council.runId})\n`);
}
