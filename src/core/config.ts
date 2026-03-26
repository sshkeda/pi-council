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
  /** Max seconds per council run. 0 = no timeout. Default: 300 (5 min). */
  timeout_seconds: number;
  system_prompt: string;
}

const CONFIG_DIR = process.env.PI_COUNCIL_HOME ?? path.join(os.homedir(), ".pi-council");
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
You MUST produce a final text answer to the question. Do not just run tools silently.
Be concise and specific.`;

const DEFAULT_CONFIG: Config = {
  models: DEFAULT_MODELS,
  tools: "bash,read",
  stall_seconds: 60,
  timeout_seconds: 600,
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

function validateModels(models: unknown): ModelSpec[] | null {
  if (!Array.isArray(models)) return null;
  const valid: ModelSpec[] = [];
  for (const m of models) {
    if (m && typeof m === "object" && typeof m.id === "string" && typeof m.provider === "string" && typeof m.model === "string") {
      valid.push({ id: m.id, provider: m.provider, model: m.model, note: typeof m.note === "string" ? m.note : undefined });
    }
  }
  return valid.length > 0 ? valid : null;
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
      models: validateModels(raw.models) ?? DEFAULT_CONFIG.models,
      tools: typeof raw.tools === "string" ? raw.tools : DEFAULT_CONFIG.tools,
      stall_seconds: typeof raw.stall_seconds === "number" && raw.stall_seconds > 0 ? raw.stall_seconds : DEFAULT_CONFIG.stall_seconds,
      timeout_seconds: typeof raw.timeout_seconds === "number" && raw.timeout_seconds >= 0 ? raw.timeout_seconds : DEFAULT_CONFIG.timeout_seconds,
      system_prompt: typeof raw.system_prompt === "string" ? raw.system_prompt : DEFAULT_CONFIG.system_prompt,
    };
  } catch (err) {
    process.stderr.write(`Warning: ${CONFIG_PATH} is invalid (${(err as Error).message}), using defaults\n`);
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
