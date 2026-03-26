import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, getRunsDir } from "../core/config.js";
import { loadMeta, refreshRun, isAgentDone, type WorkerState, type RunMeta } from "../core/run-state.js";
import { writeArtifacts as writeRunArtifacts } from "../core/artifacts.js";
import { resolveRunId } from "./status.js";
import { dim } from "../util/format.js";

function checkAllDone(runDir: string, meta: RunMeta): boolean {
  // Fast-path: only check .done files and PID liveness — no JSONL parsing
  return meta.agents.every((a) => isAgentDone(runDir, a));
}

function waitForCompletion(runDir: string, meta: RunMeta): Promise<void> {
  if (checkAllDone(runDir, meta)) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let watcher: fs.FSWatcher | null = null;
    let pidCheck: ReturnType<typeof setInterval> | null = null;

    const finish = () => {
      if (watcher) { watcher.close(); watcher = null; }
      if (pidCheck) { clearInterval(pidCheck); pidCheck = null; }
      process.removeListener("SIGINT", onSigint);
      resolve();
    };

    const onSigint = () => { finish(); };
    process.once("SIGINT", onSigint);

    try {
      watcher = fs.watch(runDir, () => {
        if (checkAllDone(runDir, meta)) finish();
      });

      watcher.on("error", () => {
        // Watcher failed — polling fallback below will handle it
        if (watcher) { watcher.close(); watcher = null; }
      });
    } catch {
      // fs.watch unavailable — rely entirely on polling fallback below
    }

    // PID liveness check every 2s — for background spawn mode
    pidCheck = setInterval(() => {
      if (checkAllDone(runDir, meta)) finish();
    }, 2_000);

    // Race-proof: check once more after setting up watchers
    if (checkAllDone(runDir, meta)) finish();
  });
}

export async function results(runId?: string, wait = true): Promise<void> {
  const resolved = resolveRunId(runId);
  const runDir = path.join(getRunsDir(), resolved);
  const meta = loadMeta(runDir);

  if (!meta) {
    process.stderr.write(`No run found: ${resolved}\n`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();

  // Wait for completion via fs.watch + PID checks (event-driven)
  if (wait) {
    await waitForCompletion(runDir, meta);
  }

  // Print results
  const states = await refreshRun(runDir, meta.agents, config.stall_seconds);

  let succeeded = 0;
  let failed = 0;

  process.stdout.write("\n");
  for (const w of states) {
    process.stdout.write("═".repeat(60) + "\n");
    process.stdout.write(`## ${w.id.toUpperCase()} (${w.model})\n`);
    process.stdout.write("═".repeat(60) + "\n");

    if (w.status === "done") {
      succeeded++;
      process.stdout.write((w.finalText || "(completed with no text output)") + "\n");
    } else {
      failed++;
      if (w.finalText) {
        process.stdout.write(w.finalText + "\n");
        process.stdout.write(`ERROR: ${w.errorMessage ?? "agent failed"}\n`);
      } else {
        process.stdout.write(`(no output)\nERROR: ${w.errorMessage ?? "empty output"}\n`);
      }
    }

    const u = w.usage;
    if (u.cost > 0) {
      process.stdout.write(dim(`  cost: $${u.cost.toFixed(4)} | tokens: ↑${u.input} ↓${u.output}`) + "\n");
    }
    process.stdout.write("\n");
  }

  process.stderr.write(`${succeeded} succeeded, ${failed} failed\n`);

  // Write artifacts only if they don't exist yet (CouncilSession already writes them for ask/extension).
  // This is needed for background `spawn` runs where results are viewed for the first time.
  const resultsJsonPath = path.join(runDir, "results.json");
  let needsArtifacts = true;
  try { fs.accessSync(resultsJsonPath); needsArtifacts = false; } catch {}

  if (needsArtifacts) writeRunArtifacts(runDir, {
    runId: resolved,
    prompt: meta.prompt,
    workers: states.map((w) => ({
      id: w.id,
      provider: w.provider,
      model: w.model,
      status: w.status,
      finalText: w.finalText,
      errorMessage: w.errorMessage,
      usage: w.usage,
    })),
  });

  // Only set exit code if no higher-priority code is already set (e.g., 124=timeout, 130=SIGINT)
  if (failed > 0 && !process.exitCode) process.exitCode = 1;
}
