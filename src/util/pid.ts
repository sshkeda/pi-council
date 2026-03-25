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
    // already dead
  }
  setTimeout(() => {
    try {
      process.kill(pid, 0); // check alive
      process.kill(pid, "SIGKILL");
    } catch {
      // dead
    }
  }, 2000);
}
