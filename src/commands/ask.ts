import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { loadConfig, resolveModels, getRunsDir, getLatestFile } from "../core/config.js";
import { spawnWorker, agentPaths } from "../core/runner.js";
import { generateRunId } from "../util/run-id.js";
import { type RunMeta } from "../core/run-state.js";
import { results } from "./results.js";
import { green, yellow, bold, dim } from "../util/format.js";

const DEFAULT_TIMEOUT_SECONDS = 30;

export interface AskOptions {
  models?: string[];
  cwd?: string;
  timeout?: number;
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

  // Spawn workers WITHOUT detaching — keep handles for instant close detection
  const children: Array<{ id: string; child: ChildProcess }> = [];
  const finished = new Set<string>();

  for (const model of models) {
    const { pid, child } = spawnWorker(runDir, model, prompt, config, opts.cwd, false);
    process.stderr.write(`  🚀 ${model.id.padEnd(8)} spawned (PID ${pid}, ${model.model})\n`);
    children.push({ id: model.id, child });

    const paths = agentPaths(runDir, model.id);

    child.on("close", (code) => {
      finished.add(model.id);
      try { fs.writeFileSync(paths.done, String(code ?? "")); } catch {}
      process.stderr.write(`  ${code === 0 ? green("✅") : yellow("⚠️")}  ${bold(model.id.padEnd(8))} finished (${finished.size}/${models.length})\n`);
    });

    child.on("error", () => {
      finished.add(model.id);
      try { fs.writeFileSync(paths.done, "1"); } catch {}
    });
  }

  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  process.stderr.write(`\n🏛️  Council running (${models.length} models, run: ${runId}, ${timeout}s timeout)\n\n`);

  // Wait for all to finish OR timeout
  await new Promise<void>((resolve) => {
    // Check completion on every close event
    const check = () => {
      if (finished.size === models.length) {
        clearTimeout(timer);
        resolve();
      }
    };
    for (const { child } of children) {
      child.on("close", check);
    }

    // Timeout
    const timer = setTimeout(() => {
      process.stderr.write(yellow(`\n⏳ Timeout after ${timeout}s.\n`));

      // Detach still-running children so this process can exit
      for (const { id, child } of children) {
        if (!finished.has(id)) {
          child.unref();
          process.stderr.write(dim(`   ${id} still running — detached (use: pi-council watch ${runId})\n`));
        }
      }
      process.stderr.write("\n");
      resolve();
    }, timeout * 1000);
  });

  // Print whatever results exist
  await results(runId, false);
}
