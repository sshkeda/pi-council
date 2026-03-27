import { Council } from "../core/council.js";
import { loadConfig } from "../core/config.js";
import { resolveModels } from "../core/profiles.js";
import type { ModelSpec } from "../core/types.js";

export interface AskOptions {
  models?: string[];
  cwd?: string;
  json?: boolean;
}

export async function ask(prompt: string, opts: AskOptions = {}): Promise<void> {
  const config = loadConfig();
  let models: ModelSpec[] = config.models;
  if (opts.models && opts.models.length > 0) {
    models = resolveModels(config.models, opts.models);
    if (models.length === 0) {
      throw new Error("No matching models found.");
    }
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

  // Support PI_COUNCIL_PI_BINARY env for testing with mock-pi
  const spawnOpts: Record<string, unknown> = { models, cwd: opts.cwd };
  if (config.systemPrompt) {
    spawnOpts.systemPrompt = config.systemPrompt;
  }
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
