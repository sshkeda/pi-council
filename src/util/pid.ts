import { execFileSync } from "node:child_process";

export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH = no such process, EPERM = process exists but we can't signal it.
    // Both mean "not our process" for practical purposes, so return false.
    return false;
  }
}

/**
 * Check if a PID belongs to a pi agent process.
 * Guards against killing unrelated processes if the PID was recycled.
 */
export function isPiProcess(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  try {
    // Use ps to get the command — works on macOS and Linux
    const output = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf-8", timeout: 2000 }).trim();
    // The pi agent runs as node/pi/tsx — check for common names
    return /\b(pi|node|tsx|bun|deno)\b/i.test(output);
  } catch {
    // ps failed (e.g., process exited between pidAlive and ps) —
    // be conservative and assume it's valid to avoid leaving orphans
    return true;
  }
}

export function killPid(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return;

  // Safety check: verify this is still a pi-related process before killing.
  // If the PID was recycled, this prevents killing unrelated processes.
  if (!isPiProcess(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // Process already exited between isPiProcess check and kill — nothing to do
  }

  // Check if dead immediately
  if (!pidAlive(pid)) return;

  // Schedule SIGKILL after 2s if still alive (non-blocking)
  setTimeout(() => {
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process exited between check and SIGKILL — expected race, nothing to do
      }
    }
  }, 2000).unref();
}
