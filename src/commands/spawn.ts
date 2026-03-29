import { Council } from "../core/council.js";
import { loadConfig, resolveProfile, resolveModelIds } from "../core/config.js";
import type { ModelSpec } from "../core/types.js";

export interface SpawnOptions {
  models?: string[];
  profile?: string;
  cwd?: string;
}

export async function spawn(prompt: string, opts: SpawnOptions = {}): Promise<void> {
  const config = loadConfig();

  let models: ModelSpec[];
  let systemPrompt: string | undefined;
  let thinking: string | undefined;
  let memberTimeoutMs: number | undefined;

  if (opts.models && opts.models.length > 0) {
    models = resolveModelIds(config, opts.models);
    if (models.length === 0) {
      const available = Object.keys(config.models).join(", ");
      throw new Error(`No matching models found. Available: ${available}`);
    }
  } else {
    const resolved = resolveProfile(config, opts.profile);
    models = resolved.models;
    systemPrompt = resolved.systemPrompt;
    thinking = resolved.thinking;
    memberTimeoutMs = resolved.memberTimeoutMs;
  }

  const council = new Council(prompt);

  const spawnOpts: Record<string, unknown> = { models, cwd: opts.cwd };
  if (systemPrompt) spawnOpts.systemPrompt = systemPrompt;
  if (thinking) spawnOpts.thinking = thinking;
  if (memberTimeoutMs) spawnOpts.memberTimeoutMs = memberTimeoutMs;
  if (process.env.PI_COUNCIL_PI_BINARY) {
    spawnOpts.piBinary = "node";
    spawnOpts.piBinaryArgs = [process.env.PI_COUNCIL_PI_BINARY];
  }
  council.spawn(spawnOpts as any);

  const modelNames = models.map((m) => m.id).join(", ");
  process.stdout.write(`${council.runId}\n`);
  process.stderr.write(`Spawned: ${modelNames} (run: ${council.runId})\n`);

  await council.waitForCompletion();
}
