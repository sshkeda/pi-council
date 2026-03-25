export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already dead
  }
  // Synchronous wait then SIGKILL if still alive
  const start = Date.now();
  while (Date.now() - start < 2000) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // dead
    }
    // busy-wait in small increments (cleanup is rare, this is fine)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already dead
  }
}
