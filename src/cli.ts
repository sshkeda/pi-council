#!/usr/bin/env node

import * as fs from "node:fs";
import { spawn } from "./commands/spawn.js";
import { status } from "./commands/status.js";
import { results } from "./commands/results.js";
import { cancel, cleanup } from "./commands/cleanup.js";
import { ask } from "./commands/ask.js";
import { list } from "./commands/list.js";
import { watch } from "./commands/watch.js";

function parseArgs(argv: string[]): {
  command: string;
  runId?: string;
  models?: string[];
  cwd?: string;
  profile?: string;
  prompt: string;
} {
  const args = argv.slice(2);
  const command = args[0] ?? "help";

  let models: string[] | undefined;
  let cwd: string | undefined;
  let runId: string | undefined;
  const rest: string[] = [];

  let i = 1;
  while (i < args.length) {
    if (args[i] === "--models" && i + 1 < args.length) {
      models = args[i + 1].split(",");
      i += 2;
    } else if (args[i] === "--cwd" && i + 1 < args.length) {
      cwd = args[i + 1];
      i += 2;
    } else {
      rest.push(args[i]);
      i++;
    }
  }

  const prompt = rest.join(" ");
  if (["status", "results", "cleanup", "cancel", "watch"].includes(command) && rest.length > 0 && /^\d{8}-/.test(rest[0])) {
    runId = rest[0];
  }

  return { command, runId, models, cwd, prompt };
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

Examples:
  pi-council ask "Should I refactor this module?"
  pi-council spawn --models claude,grok "Analyze MSFT"
  pi-council watch
  pi-council cleanup
`);
}

async function main(): Promise<void> {
  const { command, runId, models, cwd, prompt } = parseArgs(process.argv);

  switch (command) {
    case "ask":
      if (!prompt) { process.stderr.write("Error: question required\n"); process.exitCode = 1; return; }
      await ask(prompt, { models, cwd });
      break;
    case "spawn":
      if (!prompt) { process.stderr.write("Error: question required\n"); process.exitCode = 1; return; }
      spawn(prompt, { models, cwd });
      break;
    case "status":
      status(runId);
      break;
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
      list();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    case "version":
    case "--version":
    case "-v": {
      const pkgPath = new URL("../../package.json", import.meta.url);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      process.stdout.write(pkg.version + "\n");
      break;
    }
    default:
      // Treat everything as an implicit ask
      const fullPrompt = [command, prompt].filter(Boolean).join(" ");
      if (fullPrompt.trim()) {
        await ask(fullPrompt, { models, cwd });
      } else {
        printHelp();
      }
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
});
