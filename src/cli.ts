#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, resolveModels, createRun, getRunsDir, getLatestFile } from "./core/config.js";
import { spawnWorker, agentPaths } from "./core/runner.js";
import { loadMeta, refreshWorker, refreshRun, isAgentDone, killPid } from "./core/state.js";
import { CouncilSession } from "./core/session.js";

// --- Formatting ---
const isColor =
  !("NO_COLOR" in process.env) &&
  ("FORCE_COLOR" in process.env || process.stdout.isTTY === true || process.stderr.isTTY === true);
const bold = (s: string) => (isColor ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s: string) => (isColor ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (isColor ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s: string) => (isColor ? `\x1b[33m${s}\x1b[0m` : s);
const dim = (s: string) => (isColor ? `\x1b[2m${s}\x1b[0m` : s);

// --- Arg parsing ---
const KNOWN_COMMANDS = new Set([
  "ask",
  "spawn",
  "status",
  "results",
  "watch",
  "cancel",
  "cleanup",
  "list",
  "help",
  "version",
]);

export function parseArgs(argv: string[]): {
  command: string;
  runId?: string;
  models?: string[];
  cwd?: string;
  timeout?: number;
  prompt: string;
} {
  const args = argv.slice(2);
  let models: string[] | undefined,
    cwd: string | undefined,
    timeout: number | undefined,
    runId: string | undefined,
    command: string | undefined;
  const rest: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--models" && i + 1 < args.length) {
      models = args[i + 1].split(",").filter(Boolean);
      i += 2;
    } else if (args[i] === "--cwd" && i + 1 < args.length) {
      cwd = args[i + 1];
      i += 2;
    } else if (args[i] === "--timeout" && i + 1 < args.length) {
      const p = parseInt(args[i + 1], 10);
      if (Number.isFinite(p) && p >= 0) timeout = p;
      i += 2;
    } else if (args[i] === "--run-id" && i + 1 < args.length) {
      runId = args[i + 1];
      i += 2;
    } else if (args[i] === "--") {
      i++;
      while (i < args.length) {
        rest.push(args[i]);
        i++;
      }
    } else if (args[i] === "--help" || args[i] === "-h") {
      command = "help";
      i++;
    } else if (args[i] === "--version" || args[i] === "-v") {
      command = "version";
      i++;
    } else if (!command && rest.length === 0 && KNOWN_COMMANDS.has(args[i])) {
      const cmd = args[i],
        next = args[i + 1];
      const isPromptCmd = cmd === "ask" || cmd === "spawn";
      const nextOk = !next || next.startsWith("--") || /^\d{8}-/.test(next);
      if (isPromptCmd || nextOk) {
        command = cmd;
        i++;
      } else {
        rest.push(args[i]);
        i++;
      }
    } else {
      rest.push(args[i]);
      i++;
    }
  }
  if (!command) command = rest.length > 0 ? "ask" : "help";
  const prompt = rest.join(" ");
  if (
    !runId &&
    ["status", "results", "cleanup", "cancel", "watch"].includes(command) &&
    rest.length > 0 &&
    /^\d{8}-/.test(rest[0])
  )
    runId = rest[0];
  return { command, runId, models, cwd, timeout, prompt };
}

function resolveRunId(runId?: string): string {
  let resolved: string;
  if (runId) {
    resolved = runId;
  } else {
    try {
      resolved = fs.readFileSync(getLatestFile(), "utf-8").trim();
    } catch {
      throw new Error("No run specified and no latest run found.");
    }
  }
  if (resolved.includes("..") || resolved.includes("/") || resolved.includes("\\"))
    throw new Error(`Invalid run ID: ${resolved}`);
  return resolved;
}

// --- Commands ---

async function ask(prompt: string, opts: { models?: string[]; cwd?: string; timeout?: number }): Promise<void> {
  const config = loadConfig();
  const models = resolveModels(config, opts.models);
  if (models.length === 0) throw new Error("No models selected.");
  const { runId, runDir } = createRun(prompt, models, opts.cwd ?? process.cwd());
  const session = new CouncilSession({
    runId,
    runDir,
    prompt,
    models,
    config,
    cwd: opts.cwd ?? process.cwd(),
    timeoutSeconds: opts.timeout,
    events: {
      onSpawned(m, pid) {
        process.stderr.write(`  🚀 ${m.id.padEnd(8)} spawned (PID ${pid}, ${m.model})\n`);
      },
      onFinished(a, done, total) {
        const icon = a.exitCode === 0 && a.stopReason !== "error" ? green("✅") : yellow("⚠️");
        process.stderr.write(`  ${icon}  ${bold(a.id.padEnd(8))} finished (${done}/${total})\n`);
      },
      onTimeout(_, secs) {
        process.stderr.write(`\n⏰ Timeout (${secs}s)\n`);
        process.exitCode = 124;
      },
    },
  });
  const onSigint = () => {
    process.stderr.write("\n🛑 Interrupted\n");
    process.exitCode = 130;
    session.cancel();
  };
  process.once("SIGINT", onSigint);
  const ok = session.start();
  if (!ok) {
    process.exitCode = 1;
    session.dispose();
    process.removeListener("SIGINT", onSigint);
    return;
  }
  process.stderr.write(`\n🏛️  Council running (${models.length} models, run: ${runId})\n\n`);
  try {
    await session.wait();
  } finally {
    session.dispose();
    process.removeListener("SIGINT", onSigint);
  }
  await printResults(runId, false);
}

function doSpawn(prompt: string, opts: { models?: string[]; cwd?: string }): void {
  const config = loadConfig();
  const models = resolveModels(config, opts.models);
  if (models.length === 0) throw new Error("No models selected.");
  const { runId, runDir } = createRun(prompt, models, opts.cwd ?? process.cwd());
  const pids: number[] = [];
  for (const model of models) {
    try {
      const { pid } = spawnWorker(runDir, model, prompt, config, opts.cwd, true, config.timeout_seconds);
      pids.push(pid);
      process.stderr.write(`  🚀 ${model.id.padEnd(8)} spawned (PID ${pid}, ${model.model})\n`);
    } catch (err) {
      process.stderr.write(`  ❌ ${model.id.padEnd(8)} spawn failed: ${(err as Error).message}\n`);
      for (const p of pids) killPid(p);
      for (const m of models) {
        try {
          fs.writeFileSync(agentPaths(runDir, m.id).done, "1", { flag: "wx" });
        } catch {}
      }
      throw err;
    }
  }
  process.stderr.write(`\n🏛️  Council spawned (${models.length} models, run: ${runId})\n`);
  process.stdout.write(runId + "\n");
}

function status(runId?: string): void {
  const resolved = resolveRunId(runId);
  const runDir = path.join(getRunsDir(), resolved);
  const meta = loadMeta(runDir);
  if (!meta) {
    process.stderr.write(`No run found: ${resolved}\n`);
    process.exitCode = 1;
    return;
  }
  const states = refreshRun(runDir, meta.agents);
  const elapsed = ((Date.now() - meta.startedAt) / 1000).toFixed(0);
  let doneCount = 0,
    failedCount = 0;
  for (const w of states) {
    const tc = w.toolCalls > 0 ? ` tools:${w.toolCalls}` : "";
    if (w.status === "done") {
      doneCount++;
      process.stderr.write(`  ${green("✅")} ${bold(w.id.padEnd(8))} done${tc}\n`);
    } else if (w.status === "failed") {
      doneCount++;
      failedCount++;
      process.stderr.write(`  ${red("❌")} ${bold(w.id.padEnd(8))} failed: ${w.errorMessage ?? "unknown"}\n`);
    } else {
      process.stderr.write(`  ${yellow("⏳")} ${bold(w.id.padEnd(8))} running${tc}\n`);
    }
  }
  process.stderr.write(`\n  ${doneCount}/${states.length} complete, ${failedCount} failed (${elapsed}s elapsed)\n`);
  if (!states.every((w) => w.status === "done" || w.status === "failed")) process.exitCode = 2;
}

async function printResults(runId?: string, wait = true): Promise<void> {
  const resolved = resolveRunId(runId);
  const runDir = path.join(getRunsDir(), resolved);
  const meta = loadMeta(runDir);
  if (!meta) {
    process.stderr.write(`No run found: ${resolved}\n`);
    process.exitCode = 1;
    return;
  }
  if (wait) {
    await new Promise<void>((resolve) => {
      const check = () => {
        try {
          fs.accessSync(runDir);
        } catch {
          process.stderr.write("Run deleted.\n");
          process.exitCode = 1;
          resolve();
          return;
        }
        if (meta.agents.every((a) => isAgentDone(runDir, a))) {
          clearInterval(timer);
          resolve();
        }
      };
      const onSig = () => {
        process.exitCode = 130;
        clearInterval(timer);
        resolve();
      };
      process.once("SIGINT", onSig);
      const timer = setInterval(check, 1000);
      check();
    });
    if (process.exitCode === 130 || process.exitCode === 1) return;
  }
  const states = refreshRun(runDir, meta.agents);
  let succeeded = 0,
    failed = 0;
  process.stdout.write("\n");
  for (const w of states) {
    process.stdout.write("═".repeat(60) + "\n" + `## ${w.id.toUpperCase()} (${w.model})\n` + "═".repeat(60) + "\n");
    if (w.status === "done") {
      succeeded++;
      process.stdout.write((w.finalText || "(no text)") + "\n");
    } else {
      failed++;
      process.stdout.write((w.finalText ? w.finalText + "\n" : "") + `ERROR: ${w.errorMessage ?? "empty output"}\n`);
    }
    if (w.usage.cost > 0)
      process.stdout.write(
        dim(`  cost: $${w.usage.cost.toFixed(4)} | tokens: ↑${w.usage.input} ↓${w.usage.output}`) + "\n",
      );
    process.stdout.write("\n");
  }
  process.stderr.write(`${succeeded} succeeded, ${failed} failed\n`);
  // Write artifacts for background runs (ask/extension already wrote them via session)
  if (!fs.existsSync(path.join(runDir, "results.json"))) {
    const json = JSON.stringify(
      {
        runId: resolved,
        prompt: meta.prompt,
        completedAt: Date.now(),
        workers: states.map((w) => ({
          id: w.id,
          provider: w.provider,
          model: w.model,
          status: w.status,
          finalText: w.finalText,
          errorMessage: w.errorMessage,
          usage: w.usage,
        })),
      },
      null,
      2,
    );
    let md = `# pi-council results\nRun: ${resolved}\n\nQuestion:\n${meta.prompt}\n\n---\n\n`;
    for (const w of states) {
      md += `## ${w.id} — ${w.provider}/${w.model}\n\n${w.finalText || `(no output: ${w.errorMessage ?? "unknown"})`}\n\n---\n\n`;
    }
    try {
      fs.writeFileSync(path.join(runDir, "results.json"), json);
      fs.writeFileSync(path.join(runDir, "results.md"), md);
    } catch {}
  }
  if (failed > 0 && !process.exitCode) process.exitCode = 1;
}

async function watch(runId?: string): Promise<void> {
  const resolved = resolveRunId(runId);
  const runDir = path.join(getRunsDir(), resolved);
  const meta = loadMeta(runDir);
  if (!meta) {
    process.stderr.write(`No run found: ${resolved}\n`);
    process.exitCode = 1;
    return;
  }
  const remaining = new Set(meta.agents.map((a) => a.id));
  const printDone = () => {
    for (const id of [...remaining]) {
      const agent = meta.agents.find((a) => a.id === id);
      if (!agent || !isAgentDone(runDir, agent)) continue;
      remaining.delete(id);
      const w = refreshWorker(runDir, agent);
      const icon = w.status === "done" ? green("✅") : red("❌");
      process.stdout.write(
        `${icon} ${bold(w.id.toUpperCase())} (${w.model})\n${w.finalText || `(no output: ${w.errorMessage ?? "unknown"})`}\n`,
      );
      if (w.usage.cost > 0)
        process.stdout.write(
          dim(`  cost: $${w.usage.cost.toFixed(4)} | tokens: ↑${w.usage.input} ↓${w.usage.output}`) + "\n",
        );
      process.stdout.write("\n");
    }
  };
  printDone();
  if (remaining.size === 0) {
    process.stderr.write(dim("All agents already finished.\n"));
    return;
  }
  process.stderr.write(dim(`Watching ${remaining.size} remaining agent(s)...\n\n`));
  await new Promise<void>((resolve) => {
    const done = () => {
      clearInterval(timer);
      process.removeListener("SIGINT", onSig);
      resolve();
    };
    const onSig = () => {
      process.exitCode = 130;
      done();
    };
    process.once("SIGINT", onSig);
    const timer = setInterval(() => {
      printDone();
      if (remaining.size === 0) done();
    }, 2000);
  });
}

function cancel(runId?: string): void {
  const resolved = resolveRunId(runId);
  const runDir = path.join(getRunsDir(), resolved);
  const meta = loadMeta(runDir);
  if (!meta) {
    process.stderr.write(`No run found: ${resolved}\n`);
    process.exitCode = 1;
    return;
  }
  for (const agent of meta.agents) {
    const paths = agentPaths(runDir, agent.id);
    try {
      const pid = parseInt(fs.readFileSync(paths.pid, "utf-8").trim(), 10);
      if (Number.isFinite(pid)) killPid(pid);
    } catch {}
    try {
      fs.writeFileSync(paths.done, "cancelled", { flag: "wx" });
    } catch {}
  }
  process.stderr.write(`Cancelled: ${resolved}\n`);
}

function cleanup(runId?: string): void {
  const resolved = resolveRunId(runId);
  const runDir = path.join(getRunsDir(), resolved);
  const meta = loadMeta(runDir);
  if (!meta) {
    process.stderr.write(`No run found: ${resolved}\n`);
    process.exitCode = 1;
    return;
  }
  for (const agent of meta.agents) {
    try {
      const pid = parseInt(fs.readFileSync(agentPaths(runDir, agent.id).pid, "utf-8").trim(), 10);
      if (Number.isFinite(pid)) killPid(pid);
    } catch {}
  }
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch {}
  try {
    const latest = fs.readFileSync(getLatestFile(), "utf-8").trim();
    if (latest === resolved) {
      const dirs = fs
        .readdirSync(getRunsDir())
        .filter((d) => d !== resolved)
        .sort()
        .reverse();
      if (dirs.length > 0) fs.writeFileSync(getLatestFile(), dirs[0]);
      else fs.unlinkSync(getLatestFile());
    }
  } catch {}
  process.stderr.write(`Cleaned up: ${resolved}\n`);
}

function list(): void {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) {
    process.stderr.write("No runs found.\n");
    return;
  }
  const dirs = fs.readdirSync(runsDir).sort().reverse();
  if (dirs.length === 0) {
    process.stderr.write("No runs found.\n");
    return;
  }
  let latest = "";
  try {
    latest = fs.readFileSync(getLatestFile(), "utf-8").trim();
  } catch {}
  process.stderr.write(
    bold("RUN-ID".padEnd(22) + "STATUS".padEnd(12) + "AGENTS".padEnd(10) + "PROMPT") + "\n" + "─".repeat(70) + "\n",
  );
  for (const dir of dirs) {
    const meta = loadMeta(path.join(runsDir, dir));
    if (!meta) continue;
    let statusStr: string, total: number;
    try {
      const rj = JSON.parse(fs.readFileSync(path.join(runsDir, dir, "results.json"), "utf-8"));
      const workers: Array<{ status: string }> = rj.workers ?? [];
      total = workers.length;
      const fail = workers.filter((w) => w.status !== "done").length;
      statusStr = fail > 0 ? yellow(`${total - fail}/${total} ok`.padEnd(10)) : green("done".padEnd(10));
    } catch {
      const states = refreshRun(path.join(runsDir, dir), meta.agents);
      total = states.length;
      const d = states.filter((s) => s.status === "done" || s.status === "failed").length;
      const f = states.filter((s) => s.status === "failed").length;
      statusStr =
        d === total
          ? f > 0
            ? yellow(`${total - f}/${total} ok`.padEnd(10))
            : green("done".padEnd(10))
          : yellow(`${d}/${total}`.padEnd(10));
    }
    process.stderr.write(
      `${dim(dir)}${dir === latest ? " ←" : ""}  ${statusStr} ${dim(`${total} models`.padEnd(12))} ${meta.prompt.replace(/\n/g, " ").slice(0, 40)}\n`,
    );
  }
}

// --- Help + main ---

function printHelp(): void {
  process.stderr.write(`
pi-council — spawn AI models in parallel for independent opinions

Commands:
  ask "question"              One-shot: spawn, wait, print results
  spawn "question"            Background: spawn and return run-id
  status [run-id]             Show who's running, who's done
  results [run-id]            Wait for completion and print outputs
  watch [run-id]              Stream results as each agent finishes
  cancel [run-id]             Kill workers, keep files
  cleanup [run-id]            Kill workers and delete run
  list                        Show all runs

Flags:
  --models claude,gpt,grok    Select models (default: all)
  --cwd /path                  Working directory for agents
  --timeout 300                Timeout in seconds (ask only)
  --run-id <id>                Specify run ID
`);
}

async function main(): Promise<void> {
  const { command, runId, models, cwd, timeout, prompt } = parseArgs(process.argv);
  switch (command) {
    case "ask":
      if (!prompt) {
        process.stderr.write("Error: question required\n");
        process.exitCode = 1;
        return;
      }
      await ask(prompt, { models, cwd, timeout });
      break;
    case "spawn":
      if (!prompt) {
        process.stderr.write("Error: question required\n");
        process.exitCode = 1;
        return;
      }
      doSpawn(prompt, { models, cwd });
      break;
    case "status":
      status(runId);
      break;
    case "results":
      await printResults(runId);
      break;
    case "watch":
      await watch(runId);
      break;
    case "cancel":
      cancel(runId);
      break;
    case "cleanup":
      cleanup(runId);
      break;
    case "list":
      list();
      break;
    case "help":
      printHelp();
      break;
    case "version": {
      const p = new URL("../package.json", import.meta.url);
      const pkg = JSON.parse(fs.readFileSync(p, "utf-8"));
      process.stdout.write(pkg.version + "\n");
      break;
    }
    default:
      printHelp();
  }
}

const s = process.argv[1] ?? "";
if (s.includes("cli.js") || s.includes("cli.ts") || s.includes("pi-council")) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
