import { spawnSync } from "node:child_process";

interface ListedModel {
  provider: string;
  model: string;
  thinking?: boolean;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_LIST_ENV = "PI_COUNCIL_MODEL_LIST_JSON";
const GPT_LATEST_ALIASES = new Set(["gpt-latest-thinking"]);
let cachedModels: ListedModel[] | undefined;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve the special GPT latest alias:
 *   gpt-latest-thinking -> newest thinking-capable openai-codex GPT model
 *
 * This is intentionally narrow: it does not auto-resolve Gemini, Grok, Claude,
 * OpenRouter GPTs, or arbitrary "latest" aliases.
 */
export function resolveDynamicModelAlias(provider: string, model: string): string {
  const alias = parseGptLatestAlias(model);
  if (!alias) return model;

  if (provider !== "openai-codex") {
    throw new Error(
      `Model alias "${model}" only resolves for provider "openai-codex"; got provider "${provider}".`,
    );
  }

  const models = listModels();
  const candidates = models
    .filter((m) => m.provider === "openai-codex" && isGptModel(m.model) && m.thinking === true)
    .sort((a, b) => compareGptModels(a.model, b.model));

  const best = candidates[0];
  if (!best) {
    throw new Error(
      `Could not resolve model alias "${model}". ` +
      `Run \`pi --provider openai-codex --list-models gpt\` to check available models, or use a concrete model ID.`,
    );
  }

  return `${best.model}${alias.thinkingSuffix ?? ""}`;
}

export function isDynamicModelAlias(model: string): boolean {
  return parseGptLatestAlias(model) !== undefined;
}

function parseGptLatestAlias(model: string): { thinkingSuffix?: string } | undefined {
  const { base, suffix } = splitThinkingSuffix(model);
  if (!GPT_LATEST_ALIASES.has(base)) return undefined;
  return { thinkingSuffix: suffix };
}

function splitThinkingSuffix(model: string): { base: string; suffix?: string } {
  const idx = model.lastIndexOf(":");
  if (idx === -1) return { base: model };

  const suffixValue = model.slice(idx + 1);
  if (!THINKING_LEVELS.has(suffixValue)) return { base: model };
  return { base: model.slice(0, idx), suffix: model.slice(idx) };
}

function isGptModel(model: string): boolean {
  return model.startsWith("gpt-");
}

function compareGptModels(a: string, b: string): number {
  const versionCmp = compareVersionTuples(extractVersion(b), extractVersion(a));
  if (versionCmp !== 0) return versionCmp;

  const rankCmp = modelRank(b) - modelRank(a);
  if (rankCmp !== 0) return rankCmp;

  return a.localeCompare(b);
}

function extractVersion(name: string): number[] {
  const match = name.match(/gpt-(\d+(?:\.\d+)*)/);
  if (!match) return [];
  return match[1].split(".").map((part) => Number.parseInt(part, 10)).filter(Number.isFinite);
}

function compareVersionTuples(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function modelRank(name: string): number {
  const version = extractVersion(name).join(".");
  const suffix = version ? name.slice(`gpt-${version}`.length) : name;

  // At the same version, prefer the base model over variants.
  if (suffix === "") return 100;
  if (suffix === "-pro") return 80;
  if (suffix === "-codex") return 70;
  if (suffix === "-codex-max") return 65;
  if (suffix === "-mini") return 50;
  if (suffix === "-nano") return 40;
  if (suffix === "-chat") return 30;
  return 10;
}

function listModels(): ListedModel[] {
  if (cachedModels && Date.now() - cachedAt < CACHE_TTL_MS) return cachedModels;

  const envJson = process.env[MODEL_LIST_ENV];
  if (envJson) {
    cachedModels = parseEnvModelList(envJson);
    cachedAt = Date.now();
    return cachedModels;
  }

  const result = spawnSync("pi", ["--list-models", "gpt"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });

  if (result.error) {
    throw new Error(`Failed to query pi model list while resolving GPT latest alias: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `Failed to query pi model list while resolving GPT latest alias: pi exited with ${result.status}` +
      (detail ? `: ${detail}` : ""),
    );
  }

  // pi currently renders --list-models through its logger, which writes to
  // stderr; keep stdout support as a fallback in case that changes.
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  cachedModels = parsePiListModels(output);
  cachedAt = Date.now();
  return cachedModels;
}

function parseEnvModelList(json: string): ListedModel[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(`${MODEL_LIST_ENV} is not valid JSON.`);
  }

  if (!Array.isArray(raw)) {
    throw new Error(`${MODEL_LIST_ENV} must be a JSON array of { provider, model, thinking? } objects.`);
  }

  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.provider !== "string" || typeof row.model !== "string") return [];
    return [{
      provider: row.provider,
      model: row.model,
      thinking: typeof row.thinking === "boolean" ? row.thinking : undefined,
    }];
  });
}

export function parsePiListModels(output: string): ListedModel[] {
  const models: ListedModel[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("provider ")) continue;

    const match = trimmed.match(/^(\S+)\s+(\S+)\s+\S+\s+\S+\s+(yes|no)\s+(yes|no)\s*$/);
    if (!match) continue;
    models.push({
      provider: match[1],
      model: match[2],
      thinking: match[3] === "yes",
    });
  }
  return models;
}

/** Test-only: clear cached model-list state after changing PI_COUNCIL_MODEL_LIST_JSON. */
export function clearModelResolverCache(): void {
  cachedModels = undefined;
  cachedAt = 0;
}
