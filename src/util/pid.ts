import { execFileSync } from "node:child_process";

export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists but we can't signal it — it's still alive
    // ESRCH = no such process — it's dead
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Check if a PID belongs to a pi agent process.
 * Guards against killing unrelated processes if the PID was recycled.
 */
export function isPiProcess(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  try {
    // Use full command args (not just binary name) to verify this is actually a pi agent
    const output = execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf-8", timeout: 2000 }).trim();
    // Match either: pi --mode json (direct spawn) or node supervisor.js (background spawn)
    return (/\bpi\b/.test(output) && /--mode\s+json/.test(output)) || /supervisor\.js/.test(output);
  } catch (err) {
    // ENOENT = ps not available (Windows, minimal containers) — skip safety check,
    // assume it's ours to avoid leaving orphaned processes
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    // Other errors (process exited, timeout) — be conservative
    return false;
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
