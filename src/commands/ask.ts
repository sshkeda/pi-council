import { Council } from "../core/council.js";
import { DEFAULT_MODELS, resolveModels, PROFILES } from "../core/profiles.js";
import type { ModelSpec } from "../core/types.js";

export interface AskOptions {
  models?: string[];
  cwd?: string;
  profile?: string;
}

export async function ask(prompt: string, opts: AskOptions = {}): Promise<void> {
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

  // Print progress
  council.on((event) => {
    switch (event.type) {
      case "member_started":
        process.stderr.write(`  🚀 ${event.memberId.padEnd(8)} spawned (${event.model.model})\n`);
        break;
      case "member_done":
        process.stderr.write(`  ✅ ${event.memberId.padEnd(8)} done\n`);
        break;
      case "member_failed":
        process.stderr.write(`  ❌ ${event.memberId.padEnd(8)} failed: ${event.error}\n`);
        break;
    }
  });

  process.stderr.write(`\n🏛️  Council (${models.length} models, profile: ${profileName})\n\n`);

  council.spawn({
    models,
    profile: profileName,
    cwd: opts.cwd,
  });

  const result = await council.waitForCompletion();

  // Print results
  process.stderr.write(`\n`);
  for (const member of result.members) {
    const icon = member.state === "done" ? "✅" : "❌";
    const duration = member.durationMs ? ` (${(member.durationMs / 1000).toFixed(1)}s)` : "";
    process.stdout.write(`## ${icon} ${member.id.toUpperCase()} (${member.model.model})${duration}\n\n`);
    process.stdout.write(`${member.output || member.error || "(no output)"}\n\n---\n\n`);
  }
}
