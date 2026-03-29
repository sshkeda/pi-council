/**
 * Configuration — reads from ~/.pi-council/config.json.
 *
 * {
 *   "models": {
 *     "claude": { "provider": "anthropic", "model": "claude-opus-4-6" },
 *     "gpt":    { "provider": "openai-codex", "model": "gpt-5.4" }
 *   },
 *   "profiles": {
 *     "default": { "models": ["claude", "gpt", "gemini", "grok"] },
 *     "quick":   { "models": ["claude", "gpt"], "systemPrompt": "Be brief." }
 *   },
 *   "defaultProfile": "default"
 * }
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ModelSpec } from "./types.js";
import { DEFAULT_MODELS, COUNCIL_SYSTEM_PROMPT } from "./profiles.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ModelDef {
  provider: string;
  model: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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
  systemPrompt: string;
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
    systemPrompt: COUNCIL_SYSTEM_PROMPT,
  };
}

// ─── Paths ───────────────────────────────────────────────────────────

/** Resolve at call time so $HOME overrides work in tests */
export function getConfigPath(): string {
  return path.join(os.homedir(), ".pi-council", "config.json");
}

// ─── Loading ─────────────────────────────────────────────────────────

/**
 * Load config from disk, falling back to defaults.
 * Falls back to defaults on any error.
 */
export function loadConfig(): CouncilConfig {
  const configPath = getConfigPath();
  const defaults = getDefaultConfig();

  try {
    if (!fs.existsSync(configPath)) {
      saveConfig(defaults);
      return defaults;
    }
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    const models: Record<string, ModelDef> = {};
    if (raw.models && typeof raw.models === "object") {
      for (const [id, def] of Object.entries(raw.models)) {
        const d = def as Record<string, unknown>;
        if (d.provider && d.model) {
          models[id] = { provider: String(d.provider), model: String(d.model) };
        }
      }
    }
    if (Object.keys(models).length === 0) return defaults;

    const profiles: Record<string, ProfileDef> = {};
    if (raw.profiles && typeof raw.profiles === "object") {
      for (const [name, prof] of Object.entries(raw.profiles)) {
        const p = prof as Record<string, unknown>;
        if (Array.isArray(p.models) && p.models.length > 0) {
          profiles[name] = {
            models: p.models.map(String),
            ...(typeof p.systemPrompt === "string" ? { systemPrompt: p.systemPrompt } : {}),
            ...(typeof p.thinking === "string" ? { thinking: p.thinking as ThinkingLevel } : {}),
            ...(typeof p.memberTimeoutMs === "number" ? { memberTimeoutMs: p.memberTimeoutMs } : {}),
          };
        }
      }
    }

    // If no profiles defined, create a default with all models
    if (Object.keys(profiles).length === 0) {
      profiles.default = { models: Object.keys(models) };
    }

    const defaultProfile =
      typeof raw.defaultProfile === "string" && profiles[raw.defaultProfile]
        ? raw.defaultProfile
        : Object.keys(profiles)[0];

    if (typeof raw.systemPrompt !== "string" || !raw.systemPrompt) {
      return defaults;
    }

    return { models, profiles, defaultProfile, systemPrompt: raw.systemPrompt };
  } catch {
    return defaults;
  }
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
    systemPrompt: profileDef.systemPrompt ?? config.systemPrompt,
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


