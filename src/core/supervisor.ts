#!/usr/bin/env node
/**
 * Lightweight supervisor for background pi-council workers.
 * Spawned as a detached process by `pi-council spawn`. Runs pi, waits for exit,
 * writes .done with the real exit code, and enforces a timeout.
 *
 * Usage: node supervisor.js <done-path> <timeout-seconds> <pi-args...>
 *
 * This ensures background runs always have authoritative completion records
 * and respect timeouts — solving the two biggest lifecycle gaps in background mode.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";

const donePath = process.argv[2];
const timeoutSec = parseInt(process.argv[3], 10);
const piArgs = process.argv.slice(4);

if (!donePath || !piArgs.length) {
  process.exit(1);
}

const child = spawn("pi", piArgs, {
  stdio: "inherit",
  env: { ...process.env },
  detached: false, // Same process group as supervisor — killing supervisor kills pi too
});

let killed = false;

// Forward termination signals to the pi child, with SIGKILL escalation.
// This ensures the pi child dies even if the supervisor is about to be SIGKILL'd.
function terminateChild(): void {
  killed = true;
  try { child.kill("SIGTERM"); } catch {}
  // Escalate to SIGKILL quickly — we may be SIGKILL'd ourselves in ~2s
  setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
  }, 1000).unref();
}

process.on("SIGTERM", terminateChild);
process.on("SIGINT", terminateChild);

// Enforce timeout
let timer: NodeJS.Timeout | undefined;
if (timeoutSec > 0) {
  timer = setTimeout(() => {
    killed = true;
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 2000).unref();
  }, timeoutSec * 1000);
}

child.on("close", (code) => {
  if (timer) clearTimeout(timer);
  const exitCode = killed ? 124 : (code ?? 1);
  // Write-once: wx flag ensures we don't overwrite cancel/timeout markers
  try { fs.writeFileSync(donePath, String(exitCode), { flag: "wx" }); } catch {}
  process.exit(exitCode);
});

child.on("error", () => {
  if (timer) clearTimeout(timer);
  // Write-once: wx flag ensures we don't overwrite cancel/timeout markers
  try { fs.writeFileSync(donePath, "1", { flag: "wx" }); } catch {}
  process.exit(1);
});
