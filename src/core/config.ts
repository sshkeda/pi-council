/**
 * Configuration — reads from ~/.pi-council/config.json.
 *
 * {
 *   "models": {
 *     "claude": { "provider": "anthropic", "model": "claude-opus-4-6" },
 *     "gpt":    { "provider": "openai-codex", "model": "gpt-5.4" }
 *   },
 *   "profiles": {
 *     "default": { "models": ["claude", "gpt", "gemini", "grok"] }
 *   },
 *   "defaultProfile": "default"
 * }
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ModelSpec } from "./types.js";
import { DEFAULT_MODELS } from "./profiles.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ModelDef {
  provider: string;
  model: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
const VALID_THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export interface ProfileDef {
  models: string[];
  systemPrompt?: string;
  thinking?: ThinkingLevel;
  memberTimeoutMs?: number;
}

export interface CouncilConfig {
  models: Record<string, ModelDef>;
  profiles: Record<string, ProfileDef>;
  defaultProfile: string;
}

export interface ResolvedProfile {
  name: string;
  models: ModelSpec[];
  systemPrompt?: string;
  thinking?: ThinkingLevel;
  memberTimeoutMs?: number;
}

// ─── Defaults ────────────────────────────────────────────────────────

export function getDefaultConfig(): CouncilConfig {
  return {
    models: Object.fromEntries(
      DEFAULT_MODELS.map((m) => [m.id, { provider: m.provider, model: m.model }]),
    ),
    profiles: {
      default: { models: DEFAULT_MODELS.map((m) => m.id) },
    },
    defaultProfile: "default",
  };
}

// ─── Paths ───────────────────────────────────────────────────────────

/** Resolve at call time so $HOME overrides work in tests */
export function getConfigPath(): string {
  return path.join(os.homedir(), ".pi-council", "config.json");
}

// ─── Loading ─────────────────────────────────────────────────────────

/**
 * Load config from disk.
 * Throws if no config exists — run `pi-council config init` to create one.
 * Throws on malformed config.
 */
export function loadConfig(): CouncilConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No config found. Run "pi-council config init" to create one.`,
    );
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    throw new Error(
      `Config at ${configPath} is not valid JSON. Check for syntax errors.`,
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Config at ${configPath} is malformed. Expected a JSON object.`,
    );
  }

  const models: Record<string, ModelDef> = {};
  if (raw.models && typeof raw.models === "object") {
    for (const [id, def] of Object.entries(raw.models)) {
      const d = def as Record<string, unknown>;
      if (d.provider && d.model) {
        models[id] = { provider: String(d.provider), model: String(d.model) };
      }
    }
  }
  if (Object.keys(models).length === 0) {
    throw new Error(
      `Config at ${configPath} has no valid models. Check your config.`,
    );
  }

  const profiles: Record<string, ProfileDef> = {};
  if (raw.profiles && typeof raw.profiles === "object") {
    for (const [name, prof] of Object.entries(raw.profiles)) {
      const p = prof as Record<string, unknown>;
      if (Array.isArray(p.models) && p.models.length > 0) {
        profiles[name] = {
          models: p.models.map(String),
          ...(typeof p.systemPrompt === "string" ? { systemPrompt: p.systemPrompt } : {}),
          ...(typeof p.thinking === "string" && VALID_THINKING_LEVELS.has(p.thinking) ? { thinking: p.thinking as ThinkingLevel } : {}),
          ...(typeof p.memberTimeoutMs === "number" ? { memberTimeoutMs: p.memberTimeoutMs } : {}),
        };
      }
    }
  }

  if (Object.keys(profiles).length === 0) {
    throw new Error(
      `Config at ${configPath} has no valid profiles. Each profile needs a "models" array.`,
    );
  }

  // Validate every profile's model refs point to defined models
  for (const [name, prof] of Object.entries(profiles)) {
    const unknown = prof.models.filter((id) => !models[id]);
    if (unknown.length > 0) {
      throw new Error(
        `Profile "${name}" references unknown models: ${unknown.join(", ")}. Defined: ${Object.keys(models).join(", ")}`,
      );
    }
  }

  if (typeof raw.defaultProfile !== "string" || !raw.defaultProfile) {
    throw new Error(
      `Config at ${configPath} is missing "defaultProfile".`,
    );
  }
  if (!profiles[raw.defaultProfile]) {
    throw new Error(
      `Config at ${configPath} has defaultProfile "${raw.defaultProfile}" but no matching profile. Available: ${Object.keys(profiles).join(", ")}`,
    );
  }
  const defaultProfile = raw.defaultProfile;

  // Backward compat: if top-level systemPrompt exists, apply it to
  // any profiles that don't have their own systemPrompt.
  if (typeof raw.systemPrompt === "string" && raw.systemPrompt) {
    for (const prof of Object.values(profiles)) {
      if (!prof.systemPrompt) {
        prof.systemPrompt = raw.systemPrompt;
      }
    }
  }

  return { models, profiles, defaultProfile };
}

// ─── Saving ──────────────────────────────────────────────────────────

const CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/sshkeda/pi-council/main/config.schema.json";

/** Write config to disk. */
export function saveConfig(config: CouncilConfig): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const out = { $schema: CONFIG_SCHEMA_URL, ...config };
  fs.writeFileSync(configPath, JSON.stringify(out, null, 2) + "\n");
}

// ─── Profile resolution ──────────────────────────────────────────────

/**
 * Resolve a profile name to concrete ModelSpec[].
 * Uses defaultProfile when no name given.
 */
export function resolveProfile(
  config: CouncilConfig,
  profileName?: string,
): ResolvedProfile {
  const name = profileName ?? config.defaultProfile;
  const profileDef = config.profiles[name];

  if (!profileDef) {
    const available = Object.keys(config.profiles).join(", ");
    throw new Error(`Unknown profile: "${name}". Available: ${available}`);
  }

  const models: ModelSpec[] = [];
  for (const id of profileDef.models) {
    const def = config.models[id];
    if (def) {
      models.push({ id, provider: def.provider, model: def.model });
    }
  }

  if (models.length === 0) {
    const missing = profileDef.models.filter((id) => !config.models[id]);
    throw new Error(
      `Profile "${name}" references unknown models: ${missing.join(", ")}`,
    );
  }

  return {
    name,
    models,
    systemPrompt: profileDef.systemPrompt,
    thinking: profileDef.thinking,
    memberTimeoutMs: profileDef.memberTimeoutMs,
  };
}

/**
 * Resolve specific model IDs from the config's model map.
 */
export function resolveModelIds(
  config: CouncilConfig,
  ids: string[],
): ModelSpec[] {
  const models: ModelSpec[] = [];
  for (const id of ids) {
    const key = Object.keys(config.models).find(
      (k) => k.toLowerCase() === id.toLowerCase(),
    );
    if (key) {
      const def = config.models[key];
      models.push({ id: key, provider: def.provider, model: def.model });
    }
  }
  return models;
}


