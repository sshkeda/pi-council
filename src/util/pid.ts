export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killPid(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return;

  // Try killing the process group first (catches child processes like bash)
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return; // already dead
    }
  }

  // Check if dead immediately
  if (!pidAlive(pid)) return;

  // Schedule SIGKILL after 2s if still alive (non-blocking)
  setTimeout(() => {
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  }, 2000).unref();
}
