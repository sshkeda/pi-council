import { loadConfig, resolveModels } from "../core/config.js";
import { createRun } from "../core/run-lifecycle.js";
import { CouncilSession } from "../core/council-session.js";
import { results } from "./results.js";
import { green, yellow, red, bold } from "../util/format.js";

export interface AskOptions {
  models?: string[];
  cwd?: string;
  /** Overall timeout in seconds. 0 = no timeout. Falls back to config default. */
  timeout?: number;
}

export async function ask(prompt: string, opts: AskOptions = {}): Promise<void> {
  const config = loadConfig();
  const models = resolveModels(config, opts.models);

  if (models.length === 0) {
    throw new Error("No models selected.");
  }

  const { runId, runDir } = createRun(prompt, models, opts.cwd ?? process.cwd());

  const session = new CouncilSession({
    runId, runDir, prompt, models, config,
    cwd: opts.cwd ?? process.cwd(),
    timeoutSeconds: opts.timeout,
    events: {
      onSpawned(model, pid) {
        process.stderr.write(`  🚀 ${model.id.padEnd(8)} spawned (PID ${pid}, ${model.model})\n`);
      },
      onSpawnError(model, error) {
        process.stderr.write(`  ${red("❌")} ${bold(model.id.padEnd(8))} spawn failed: ${error.message}\n`);
      },
      onFinished(agent, done, total) {
        const icon = agent.exitCode === 0 ? green("✅") : yellow("⚠️");
        process.stderr.write(`  ${icon}  ${bold(agent.id.padEnd(8))} finished (${done}/${total})\n`);
      },
      onTimeout(_agents, secs) {
        process.stderr.write(`\n⏰ Timeout (${secs}s) — killing remaining agents\n`);
        process.exitCode = 124;
      },
    },
  });

  // Handle signals
  const onSigint = () => { process.stderr.write("\n🛑 Interrupted\n"); process.exitCode = 130; session.cancel(); };
  const onSigterm = () => { process.stderr.write("\n🛑 Terminated\n"); process.exitCode = 143; session.cancel(); };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const started = session.start();
  if (!started) {
    process.stderr.write("🛑 Spawn failure — killing previously started agents\n");
    process.exitCode = 1;
    session.dispose();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    return;
  }

  process.stderr.write(`\n🏛️  Council running (${models.length} models, run: ${runId})\n\n`);

  try {
    await session.waitForCompletion();
  } finally {
    session.dispose();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  // Print results
  await results(runId, false);
}
