import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

export interface ModelSpec {
  id: string;
  provider: string;
  model: string;
  note?: string;
}

export interface Config {
  models: ModelSpec[];
  tools: string;
  timeout_seconds: number;
  system_prompt: string;
}

export interface RunMeta {
  runId: string;
  prompt: string;
  startedAt: number;
  agents: ModelSpec[];
  cwd: string;
}

// Lazy path resolution — honors PI_COUNCIL_HOME at runtime (tests)
function configDir(): string { return process.env.PI_COUNCIL_HOME ?? path.join(os.homedir(), ".pi-council"); }
export function getConfigDir(): string { return configDir(); }
export function getRunsDir(): string { return path.join(configDir(), "runs"); }
export function getLatestFile(): string { return path.join(configDir(), "latest-run-id"); }

export const DEFAULT_MODELS: ModelSpec[] = [
  { id: "claude", provider: "anthropic", model: "claude-opus-4-6" },
  { id: "gpt", provider: "openai-codex", model: "gpt-5.4" },
  { id: "gemini", provider: "google", model: "gemini-3.1-pro-preview" },
  { id: "grok", provider: "xai", model: "grok-4.20-0309-reasoning" },
];

export const DEFAULT_SYSTEM_PROMPT = `You are one member of a multi-model council.
Work independently. Do your own research using your tools.
Do NOT spawn other agents, run council commands, or coordinate with other models.
You MUST produce a final text answer to the question. Do not just run tools silently.
Be concise and specific.`;

const DEFAULT_CONFIG: Config = {
  models: DEFAULT_MODELS,
  tools: "bash,read",
  timeout_seconds: 600,
  system_prompt: DEFAULT_SYSTEM_PROMPT,
};

export function loadConfig(): Config {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.mkdirSync(getRunsDir(), { recursive: true });
  const cp = path.join(configDir(), "config.json");
  if (!fs.existsSync(cp)) {
    fs.writeFileSync(cp, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(cp, "utf-8"));
    return {
      models: Array.isArray(raw.models) ? raw.models.filter((m: unknown) =>
        m && typeof m === "object" && typeof (m as ModelSpec).id === "string" && typeof (m as ModelSpec).provider === "string" && typeof (m as ModelSpec).model === "string"
      ) : DEFAULT_CONFIG.models,
      tools: typeof raw.tools === "string" ? raw.tools : DEFAULT_CONFIG.tools,
      timeout_seconds: typeof raw.timeout_seconds === "number" && raw.timeout_seconds >= 0 ? raw.timeout_seconds : DEFAULT_CONFIG.timeout_seconds,
      system_prompt: typeof raw.system_prompt === "string" ? raw.system_prompt : DEFAULT_CONFIG.system_prompt,
    };
  } catch (err) {
    process.stderr.write(`Warning: config invalid (${(err as Error).message}), using defaults\n`);
    return { ...DEFAULT_CONFIG };
  }
}

export function resolveModels(config: Config, filter?: string[]): ModelSpec[] {
  if (!filter || filter.length === 0) return config.models;
  const wanted = new Set(filter.map((s) => s.trim().toLowerCase()));
  const found = config.models.filter((m) => wanted.has(m.id.toLowerCase()));
  const missing = [...wanted].filter((w) => !found.some((f) => f.id.toLowerCase() === w));
  if (missing.length > 0) throw new Error(`Unknown model(s): ${missing.join(", ")}. Available: ${config.models.map((m) => m.id).join(", ")}`);
  return found;
}

export function createRun(prompt: string, models: ModelSpec[], cwd: string): { runId: string; runDir: string } {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const runId = `${date}-${time}-${crypto.randomBytes(4).toString("hex")}`;
  const runDir = path.join(getRunsDir(), runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "prompt.txt"), prompt);
  fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify({ runId, prompt, startedAt: Date.now(), agents: models, cwd } as RunMeta, null, 2));
  fs.writeFileSync(getLatestFile(), runId);
  return { runId, runDir };
}
