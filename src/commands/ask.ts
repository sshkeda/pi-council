import { spawn } from "./spawn.js";
import { results } from "./results.js";

export interface AskOptions {
  models?: string[];
  cwd?: string;
}

export async function ask(prompt: string, opts: AskOptions = {}): Promise<void> {
  const runId = spawn(prompt, opts);
  process.stderr.write("\n");
  await results(runId, true);
}
