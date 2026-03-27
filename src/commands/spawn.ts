import { Council, registry } from "../core/council.js";
import { PROFILES, resolveModels } from "../core/profiles.js";
import type { ModelSpec } from "../core/types.js";

export interface SpawnOptions {
  models?: string[];
  cwd?: string;
  profile?: string;
}

export function spawn(prompt: string, opts: SpawnOptions = {}): void {
  const profileName = opts.profile ?? "max";
  const profile = PROFILES[profileName];
  if (!profile) {
    throw new Error(`Unknown profile: ${profileName}`);
  }

  let models: ModelSpec[] = profile.models;
  if (opts.models && opts.models.length > 0) {
    models = resolveModels(profile.models, opts.models);
    if (models.length === 0) {
      throw new Error("No matching models found.");
    }
  }

  const council = new Council(prompt);
  registry.add(council);

  council.spawn({
    models,
    profile: profileName,
    cwd: opts.cwd,
  });

  const modelNames = models.map((m) => m.id).join(", ");
  process.stdout.write(`${council.runId}\n`);
  process.stderr.write(`Spawned: ${modelNames} (run: ${council.runId}, profile: ${profileName})\n`);
}
