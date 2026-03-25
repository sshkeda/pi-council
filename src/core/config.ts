import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface ModelSpec {
  id: string;
  provider: string;
  model: string;
  note?: string;
}

export interface Config {
  models: ModelSpec[];
  tools: string;
  stall_seconds: number;
  system_prompt: string;
}

const CONFIG_DIR = path.join(os.homedir(), ".pi-council");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const RUNS_DIR = path.join(CONFIG_DIR, "runs");
const LATEST_FILE = path.join(CONFIG_DIR, "latest-run-id");

export const DEFAULT_MODELS: ModelSpec[] = [
  { id: "claude", provider: "anthropic", model: "claude-opus-4-6", note: "Strong at nuanced reasoning" },
  { id: "gpt", provider: "openai-codex", model: "gpt-5.4", note: "Good at structured analysis" },
  { id: "gemini", provider: "google", model: "gemini-3.1-pro-preview", note: "Fast, good at data analysis" },
  { id: "grok", provider: "xai", model: "grok-4.20-0309-reasoning", note: "Has live X/Twitter access" },
];

export const DEFAULT_SYSTEM_PROMPT = `You are one member of a multi-model council.
Work independently. Do your own research using your tools.
Do NOT spawn other agents, run council commands, or coordinate with other models.
Be concise and specific.`;

const DEFAULT_CONFIG: Config = {
  models: DEFAULT_MODELS,
  tools: "bash,read",
  stall_seconds: 60,
  system_prompt: DEFAULT_SYSTEM_PROMPT,
};

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getRunsDir(): string {
  return RUNS_DIR;
}

export function getLatestFile(): string {
  return LATEST_FILE;
}

export function loadConfig(): Config {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return {
      models: raw.models ?? DEFAULT_CONFIG.models,
      tools: raw.tools ?? DEFAULT_CONFIG.tools,
      stall_seconds: raw.stall_seconds ?? DEFAULT_CONFIG.stall_seconds,
      system_prompt: raw.system_prompt ?? DEFAULT_CONFIG.system_prompt,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function resolveModels(config: Config, filter?: string[]): ModelSpec[] {
  if (!filter || filter.length === 0) return config.models;
  const wanted = new Set(filter.map((s) => s.trim().toLowerCase()));
  const found = config.models.filter((m) => wanted.has(m.id.toLowerCase()));
  const missing = [...wanted].filter((w) => !found.some((f) => f.id.toLowerCase() === w));
  if (missing.length > 0) {
    const available = config.models.map((m) => m.id).join(", ");
    throw new Error(`Unknown model(s): ${missing.join(", ")}. Available: ${available}`);
  }
  return found;
}
