#!/usr/bin/env node

import * as fs from "node:fs";
import { spawn } from "./commands/spawn.js";
import { status } from "./commands/status.js";
import { results } from "./commands/results.js";
import { cancel, cleanup } from "./commands/cleanup.js";
import { ask } from "./commands/ask.js";
import { list } from "./commands/list.js";
import { watch } from "./commands/watch.js";

const KNOWN_COMMANDS = new Set(["ask", "spawn", "status", "results", "watch", "cancel", "cleanup", "list", "help", "version"]);

export function parseArgs(argv: string[]): { command: string; runId?: string; models?: string[]; cwd?: string; timeout?: number; prompt: string } {
  const args = argv.slice(2);

  let models: string[] | undefined;
  let cwd: string | undefined;
  let timeout: number | undefined;
  let runId: string | undefined;
  let command: string | undefined;
  const rest: string[] = [];

  // Two-pass: extract flags first, then identify command and positional args
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--models" && i + 1 < args.length) {
      models = args[i + 1].split(",").filter(Boolean);
      i += 2;
    } else if (args[i] === "--cwd" && i + 1 < args.length) {
      cwd = args[i + 1];
      i += 2;
    } else if (args[i] === "--timeout" && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        timeout = parsed;
      } else {
        process.stderr.write(`Warning: invalid --timeout value "${args[i + 1]}", ignoring\n`);
      }
      i += 2;
    } else if (args[i] === "--run-id" && i + 1 < args.length) {
      runId = args[i + 1];
      i += 2;
    } else if (args[i] === "--help" || args[i] === "-h") {
      command = "help";
      i++;
    } else if (args[i] === "--version" || args[i] === "-v") {
      command = "version";
      i++;
    } else if (args[i] === "--") {
      // End of flags — everything after this is prompt text
      i++;
      while (i < args.length) { rest.push(args[i]); i++; }
    } else if (!command && rest.length === 0 && KNOWN_COMMANDS.has(args[i])) {
      // Only match commands as the FIRST non-flag token.
      // This prevents prompts like "check the status of X" from being parsed as the "status" command.
      command = args[i];
      i++;
    } else {
      rest.push(args[i]);
      i++;
    }
  }

  // Default to "help" if nothing provided, or implicit "ask" if there's a prompt
  if (!command) {
    command = rest.length > 0 ? "ask" : "help";
  }

  // For status/results/cleanup/watch, first positional arg might be a run-id (looks like YYYYMMDD-...)
  const prompt = rest.join(" ");
  if (!runId && ["status", "results", "cleanup", "cancel", "watch"].includes(command) && rest.length > 0 && /^\d{8}-/.test(rest[0])) {
    runId = rest[0];
  }

  return { command, runId, models, cwd, timeout, prompt };
}

function printHelp(): void {
  process.stderr.write(`
pi-council — spawn different AI models in parallel to get independent opinions

Commands:
  ask "question"              One-shot: spawn, wait, print results
  spawn "question"            Background: spawn and return run-id
  status [run-id]             Show who's running, who's done
  results [run-id]            Wait for completion and print outputs
  watch [run-id]              Stream results as each agent finishes
  cancel [run-id]             Kill workers, keep files for inspection
  cleanup [run-id]            Kill workers and delete run
  list                        Show all runs

Flags:
  --models claude,gpt,grok    Select which models to run (default: all)
  --cwd /path                  Working directory for agents
  --timeout 300                Timeout in seconds for ask command (kills agents)
  --run-id <id>                Specify run ID for status/results/watch/cancel/cleanup

Examples:
  pi-council ask "Should I refactor this module?"
  pi-council ask --timeout 120 "Quick code review"
  pi-council spawn --models claude,grok "Analyze MSFT"
  pi-council watch
  pi-council cleanup
`);
}

async function main(): Promise<void> {
  const { command, runId, models, cwd, timeout, prompt } = parseArgs(process.argv);

  switch (command) {
    case "ask":
      if (!prompt) { process.stderr.write("Error: question required\n"); process.exitCode = 1; return; }
      await ask(prompt, { models, cwd, timeout });
      break;
    case "spawn":
      if (!prompt) { process.stderr.write("Error: question required\n"); process.exitCode = 1; return; }
      spawn(prompt, { models, cwd });
      break;
    case "status": {
      const allDone = status(runId);
      if (!allDone) process.exitCode = 2; // non-zero if still running
      break;
    }
    case "results":
      await results(runId);
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
      await list();
      break;
    case "help":
      printHelp();
      break;
    case "version": {
      const pkgPath = new URL("../../package.json", import.meta.url);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      process.stdout.write(pkg.version + "\n");
      break;
    }
    default:
      printHelp();
  }
}

// Only run main() when executed directly, not when imported for testing
// Only run main() when executed directly, not when imported for testing
const scriptName = process.argv[1] ?? "";
const isDirectRun = scriptName.includes("cli.js") || scriptName.includes("cli.ts") || scriptName.includes("pi-council");
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
