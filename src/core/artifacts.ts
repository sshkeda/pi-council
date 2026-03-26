import * as fs from "node:fs";
import * as path from "node:path";

/** Worker result for artifact generation — unified schema for CLI and extension. */
export interface WorkerResult {
  id: string;
  provider: string;
  model: string;
  status: string;
  finalText: string;
  errorMessage: string | null;
  exitCode?: number | null;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
}

export interface ArtifactData {
  runId: string;
  prompt: string;
  workers: WorkerResult[];
}

/**
 * Generate results.md content.
 * Single source of truth — used by both CLI and extension.
 */
export function generateResultsMd(data: ArtifactData): string {
  let md = `# pi-council results\nRun: ${data.runId}\n\n`;
  md += `Question:\n${data.prompt}\n\n---\n\n`;
  for (const w of data.workers) {
    md += `## ${w.id} — ${w.provider}/${w.model}\n\n`;
    md += (w.finalText || `(no output: ${w.errorMessage ?? "unknown"})`) + "\n\n";
    if (w.usage.cost > 0) {
      md += `*cost: $${w.usage.cost.toFixed(4)} | tokens: ↑${w.usage.input} ↓${w.usage.output}*\n\n`;
    }
    md += "---\n\n";
  }
  return md;
}

/**
 * Generate results.json content.
 * Single source of truth — used by both CLI and extension.
 */
export function generateResultsJson(data: ArtifactData): string {
  return JSON.stringify({
    runId: data.runId,
    prompt: data.prompt,
    completedAt: Date.now(),
    workers: data.workers.map((w) => ({
      id: w.id,
      provider: w.provider,
      model: w.model,
      status: w.status,
      finalText: w.finalText,
      errorMessage: w.errorMessage,
      usage: w.usage,
    })),
  }, null, 2);
}

/**
 * Write results.md and results.json to the run directory.
 * Single source of truth — used by both CLI and extension.
 */
export function writeArtifacts(runDir: string, data: ArtifactData): void {
  try {
    fs.writeFileSync(path.join(runDir, "results.md"), generateResultsMd(data));
    fs.writeFileSync(path.join(runDir, "results.json"), generateResultsJson(data));
  } catch (err) {
    process.stderr.write(`⚠️  Failed to write council artifacts: ${(err as Error).message}\n`);
  }
}
