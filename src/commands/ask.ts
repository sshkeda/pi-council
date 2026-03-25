import * as fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { loadConfig, resolveModels } from "../core/config.js";
import { spawnWorker, agentPaths } from "../core/runner.js";
import { createRun } from "../core/run-lifecycle.js";
import { killPid } from "../util/pid.js";
import { results } from "./results.js";
import { green, yellow, red, bold } from "../util/format.js";

export interface AskOptions {
  models?: string[];
  cwd?: string;
  /** Overall timeout in seconds. 0 = no timeout (default). */
  timeout?: number;
}

export async function ask(prompt: string, opts: AskOptions = {}): Promise<void> {
  const config = loadConfig();
  const models = resolveModels(config, opts.models);

  if (models.length === 0) {
    throw new Error("No models selected.");
  }

  const { runId, runDir } = createRun(prompt, models, opts.cwd ?? process.cwd());

  // Spawn workers WITHOUT detaching — keep handles for instant close detection
  const finished = new Set<string>();
  const children: ChildProcess[] = [];
  const promises: Promise<void>[] = [];

  const writeDone = (modelId: string, content: string): void => {
    try {
      fs.writeFileSync(agentPaths(runDir, modelId).done, content);
    } catch (err) {
      process.stderr.write(`  ⚠️  Failed to write .done for ${modelId}: ${(err as Error).message}\n`);
    }
  };

  let shuttingDown = false;
  const terminateRemaining = (reason: string, exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exitCode = exitCode;
    process.stderr.write(`\n${reason}\n`);

    for (const model of models) {
      if (!finished.has(model.id) && !fs.existsSync(agentPaths(runDir, model.id).done)) {
        writeDone(model.id, "cancelled");
      }
    }

    for (const child of children) {
      if (child.pid !== undefined) {
        killPid(child.pid);
      } else {
        try {
          child.kill("SIGTERM");
        } catch {
          // already dead
        }
      }
    }
  };

  const onSigint = () => terminateRemaining("🛑 Interrupted — killing remaining agents", 130);
  const onSigterm = () => terminateRemaining("🛑 Terminated — killing remaining agents", 143);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  for (const model of models) {
    const { pid, child } = spawnWorker(runDir, model, prompt, config, opts.cwd, false);
    children.push(child);
    process.stderr.write(`  🚀 ${model.id.padEnd(8)} spawned (PID ${pid}, ${model.model})\n`);

    promises.push(
      new Promise<void>((resolve) => {
        child.on("close", (code) => {
          finished.add(model.id);
          writeDone(model.id, String(code ?? ""));
          process.stderr.write(`  ${code === 0 ? green("✅") : yellow("⚠️")}  ${bold(model.id.padEnd(8))} finished (${finished.size}/${models.length})\n`);
          resolve();
        });
        child.on("error", (err) => {
          finished.add(model.id);
          process.stderr.write(`  ${red("❌")} ${bold(model.id.padEnd(8))} error: ${err.message}\n`);
          writeDone(model.id, "1");
          resolve();
        });
      }),
    );
  }

  process.stderr.write(`\n🏛️  Council running (${models.length} models, run: ${runId})\n\n`);

  let timer: NodeJS.Timeout | undefined;
  try {
    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        terminateRemaining(`⏰ Timeout (${opts.timeout}s) — killing remaining agents`, 124);
      }, opts.timeout * 1000);
      timer.unref();
    }

    await Promise.allSettled(promises);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  // Print results
  await results(runId, false);
}
