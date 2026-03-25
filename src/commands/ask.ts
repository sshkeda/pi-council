import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, resolveModels, getRunsDir, getLatestFile } from "../core/config.js";
import { spawnWorker, agentPaths } from "../core/runner.js";
import { generateRunId } from "../util/run-id.js";
import { refreshRun, type RunMeta } from "../core/run-state.js";
import { results } from "./results.js";
import { green, yellow, bold } from "../util/format.js";

export interface AskOptions {
  models?: string[];
  cwd?: string;
}

export async function ask(prompt: string, opts: AskOptions = {}): Promise<void> {
  const config = loadConfig();
  const models = resolveModels(config, opts.models);

  if (models.length === 0) {
    throw new Error("No models selected.");
  }

  const runId = generateRunId();
  const runDir = path.join(getRunsDir(), runId);
  fs.mkdirSync(runDir, { recursive: true });

  fs.writeFileSync(path.join(runDir, "prompt.txt"), prompt);
  const meta: RunMeta = {
    runId,
    prompt,
    startedAt: Date.now(),
    agents: models,
    cwd: opts.cwd ?? process.cwd(),
  };
  fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
  fs.writeFileSync(getLatestFile(), runId);

  // Spawn workers WITHOUT detaching — keep handles
  const promises: Promise<{ id: string; code: number | null }>[] = [];

  for (const model of models) {
    const { pid, child } = spawnWorker(runDir, model, prompt, config, opts.cwd, false);
    process.stderr.write(`  🚀 ${model.id.padEnd(8)} spawned (PID ${pid}, ${model.model})\n`);

    const paths = agentPaths(runDir, model.id);

    promises.push(
      new Promise((resolve) => {
        child.on("close", (code) => {
          try { fs.writeFileSync(paths.done, String(code ?? "")); } catch {}
          process.stderr.write(`  ${code === 0 ? green("✅") : yellow("⚠️")}  ${bold(model.id.padEnd(8))} finished\n`);
          resolve({ id: model.id, code });
        });
        child.on("error", () => {
          try { fs.writeFileSync(paths.done, "1"); } catch {}
          resolve({ id: model.id, code: 1 });
        });
      }),
    );
  }

  process.stderr.write(`\n🏛️  Council running (${models.length} models, run: ${runId})\n\n`);

  // allSettled — partial failures don't block the rest
  await Promise.allSettled(promises);

  // All settled — print results immediately
  await results(runId, false);
}
