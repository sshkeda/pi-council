import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function getCouncilHomeDir(): string {
  return path.join(os.homedir(), ".pi-council");
}

export function getRunsDir(): string {
  return path.join(getCouncilHomeDir(), "runs");
}

export function getRunDir(runId: string): string {
  return path.join(getRunsDir(), runId);
}

export function getLatestRunIdPath(): string {
  return path.join(getCouncilHomeDir(), "latest-run-id");
}

export function setLatestRunId(runId: string): void {
  const filePath = getLatestRunIdPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, runId + "\n");
}

export function getLatestRunId(): string | undefined {
  try {
    return fs.readFileSync(getLatestRunIdPath(), "utf-8").trim() || undefined;
  } catch {}

  if (!fs.existsSync(getRunsDir())) return undefined;
  const dirs = fs.readdirSync(getRunsDir()).sort().reverse();
  return dirs[0];
}
