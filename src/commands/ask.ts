import { Council } from "../core/council.js";
import { loadConfig, resolveProfile, resolveModelIds } from "../core/config.js";
import type { ModelSpec } from "../core/types.js";

export interface AskOptions {
  models?: string[];
  profile?: string;
  cwd?: string;
  json?: boolean;
}

export async function ask(prompt: string, opts: AskOptions = {}): Promise<void> {
  const config = loadConfig();

  // Resolve models: --models flag picks from all defined models,
  // --profile uses a named profile, default uses the default profile.
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

  process.stderr.write(`\n🏛️  Council (${models.length} models)\n\n`);

  const spawnOpts: Record<string, unknown> = { models, cwd: opts.cwd };
  if (systemPrompt) spawnOpts.systemPrompt = systemPrompt;
  if (thinking) spawnOpts.thinking = thinking;
  if (memberTimeoutMs) spawnOpts.memberTimeoutMs = memberTimeoutMs;
  if (process.env.PI_COUNCIL_PI_BINARY) {
    spawnOpts.piBinary = "node";
    spawnOpts.piBinaryArgs = [process.env.PI_COUNCIL_PI_BINARY];
  }
  council.spawn(spawnOpts as any);

  // Handle Ctrl+C — cancel council and exit cleanly
  const sigintHandler = () => {
    council.cancel();
    process.stderr.write("\n\nCancelled.\n");
    process.exitCode = 130;
  };
  process.on("SIGINT", sigintHandler);

  const result = await council.waitForCompletion();
  process.off("SIGINT", sigintHandler);

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stderr.write(`\n`);
    for (const member of result.members) {
      const icon = member.state === "done" ? "✅" : "❌";
      const duration = member.durationMs ? ` (${(member.durationMs / 1000).toFixed(1)}s)` : "";
      process.stdout.write(`## ${icon} ${member.id.toUpperCase()} (${member.model.model})${duration}\n\n`);
      process.stdout.write(`${member.output || member.error || "(no output)"}\n\n---\n\n`);
    }
  }
}
