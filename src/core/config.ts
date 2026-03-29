/**
 * Configuration loading — reads from ~/.pi-council/config.json if it exists.
 * Falls back to defaults for anything not specified.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ModelSpec } from "./types.js";
import { DEFAULT_MODELS } from "./profiles.js";

export interface CouncilConfig {
  models: ModelSpec[];
  systemPrompt?: string;
  /** Per-member timeout in ms. Members exceeding this are cancelled. */
  memberTimeoutMs?: number;
}

/** Resolve config dir at call time so $HOME overrides work */
function getConfigPath(): string {
  return path.join(os.homedir(), ".pi-council", "config.json");
}

/**
 * Load config from disk, falling back to defaults.
 * Never throws — returns defaults on any error.
 */
export function loadConfig(): CouncilConfig {
  const configPath = getConfigPath();

  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return {
        models: Array.isArray(raw.models) && raw.models.length > 0
          ? raw.models.map((m: Record<string, unknown>) => ({
              id: String(m.id ?? ""),
              provider: String(m.provider ?? ""),
              model: String(m.model ?? ""),
            })).filter((m: ModelSpec) => m.id && m.provider && m.model)
          : DEFAULT_MODELS,
        systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : undefined,
        memberTimeoutMs: typeof raw.memberTimeoutMs === "number" ? raw.memberTimeoutMs : undefined,
      };
    }
  } catch {
    // Corrupt config — fall back to defaults
  }

  return { models: DEFAULT_MODELS };
}

/**
 * Write a default config file if none exists.
 */
export function ensureConfig(): void {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);

  try {
    fs.mkdirSync(configDir, { recursive: true });
    if (!fs.existsSync(configPath)) {
      const defaultConfig = {
        models: DEFAULT_MODELS,
      };
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    }
  } catch {
    // Non-fatal — can work without config file
  }
}
