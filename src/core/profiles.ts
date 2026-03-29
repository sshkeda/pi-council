/**
 * Built-in defaults for the council system.
 */

import type { ModelSpec } from "./types.js";

export const DEFAULT_MODELS: ModelSpec[] = [
  { id: "claude", provider: "anthropic", model: "claude-opus-4-6" },
  { id: "gpt", provider: "openai-codex", model: "gpt-5.4" },
  { id: "gemini", provider: "google", model: "gemini-3.1-pro-preview" },
  { id: "grok", provider: "xai", model: "grok-4.20-0309-reasoning" },
];

export const COUNCIL_SYSTEM_PROMPT = `You are one member of a multi-model council. Multiple AI models have been given the same question independently. Your job is to provide YOUR perspective — do your own research, form your own opinion, and be specific.

Rules:
- Work independently. Do NOT try to coordinate with other models.
- Do NOT spawn other agents or run council commands.
- Use your tools to investigate if the question is about code, files, or data.
- Be concise and specific. Give your actual opinion, not a generic overview.
- If you disagree with a common assumption, say so clearly and explain why.`;
