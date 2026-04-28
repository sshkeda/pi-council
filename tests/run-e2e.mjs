#!/usr/bin/env node

/**
 * Runs independent E2E suites concurrently after the project has been built.
 * Keeps each suite's output grouped while still preserving each process' exit code.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const suites = [
  "tests/e2e-extension.test.mjs",
  "tests/e2e-mcp.test.mjs",
];

function runSuite(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: rootDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      resolve({ script, code: 1, stdout, stderr: stderr + String(error.stack || error) });
    });
    child.on("close", (code) => {
      resolve({ script, code: code ?? 1, stdout, stderr });
    });
  });
}

const results = await Promise.all(suites.map(runSuite));
for (const result of results) {
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

process.exit(results.some((result) => result.code !== 0) ? 1 : 0);
