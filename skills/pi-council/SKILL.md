---
name: pi-council
description: >
  Spawn multiple AI models (Claude, GPT, Gemini, Grok) as independent pi agents
  to get parallel opinions on any question. Use when you need diverse model perspectives
  on architecture decisions, investment analysis, code review, or any high-stakes question.
version: 0.1.0
license: MIT
---

# pi-council

Spawns multi-model AI agents in parallel via RPC. Each model is its own pi coding agent with
tools and full bidirectional communication.

## Core principle: UNBIASED PROMPTING

When formulating a council question, you MUST strip your own conclusions, opinions, and biases.
The value of the council is in receiving genuinely independent perspectives. If you lead the
models toward your preferred answer, you defeat the purpose.

**DO:**
- Present the raw situation and constraints neutrally
- Include relevant context (code, data, requirements) without editorializing
- Ask open-ended questions: "What approach would you recommend?"

**DON'T:**
- Include your own analysis or preferred solution
- Frame the question to lead toward a specific answer
- Cherry-pick context that supports one conclusion

The differing opinions ARE the product. They give you signal you can't get from a single model.

## Pi extension tools

### spawn_council
Spawn a council. Returns immediately — results auto-delivered as each member finishes.

Parameters:
- `question` (required): The question for the council. Frame it neutrally.
- `profile` (optional): Named profile from config e.g. `"quick"`, `"code-review"`. Default: the `defaultProfile` from config.
- `models` (optional): Array of model IDs e.g. `["claude", "grok"]`. Overrides profile if both given.
- `label` (optional): Short label for status widget.

### council_followup
Send a follow-up to running council members.

Parameters:
- `message` (required): The follow-up message
- `type` (required): `"abort"` (interrupt immediately) or `"steer"` (queue after current tool call)
- `runId` (optional): Target specific council run
- `memberIds` (optional): Target specific members

### cancel_council
Cancel a running council or specific members.

### council_status
Get detailed status of all council members — state, elapsed time, streaming status, stderr, output length.
**Only use when something seems stuck or the user explicitly asks.** Do NOT poll after spawning.

### read_stream
Read a member's full accumulated output, stderr, and debug info.
**Only use to re-read a past result or when the user asks.** Output is auto-delivered via followUp.

## Configuration

Config file: `~/.pi-council/config.json`

Run `pi-council config` to view current config, `pi-council config path` to print the file path.

### Schema

```json
{
  "systemPrompt": "base system prompt for all council members",
  "models": {
    "<id>": { "provider": "<provider>", "model": "<model-name>" }
  },
  "profiles": {
    "<name>": {
      "models": ["<model-id>", ...],
      "systemPrompt": "overrides the top-level systemPrompt for this profile",
      "thinking": "off | minimal | low | medium | high | xhigh",
      "memberTimeoutMs": 120000
    }
  },
  "defaultProfile": "<profile-name>"
}
```

### Invariants
- Every model ID in a profile's `models` array must exist in the top-level `models` map
- `defaultProfile` must reference an existing profile name
- At least one profile must exist
- Top-level `systemPrompt` applies to all profiles unless overridden per-profile

### Example config

```json
{
  "models": {
    "claude": { "provider": "anthropic", "model": "claude-opus-4-6" },
    "gpt": { "provider": "openai-codex", "model": "gpt-5.4" },
    "gemini": { "provider": "google", "model": "gemini-3.1-pro-preview" },
    "grok": { "provider": "xai", "model": "grok-4.20-0309-reasoning" },
    "deepseek": { "provider": "deepseek", "model": "deepseek-r1" }
  },
  "profiles": {
    "default": {
      "models": ["claude", "gpt", "gemini", "grok"]
    },
    "quick": {
      "models": ["claude", "gpt"]
    },
    "code-review": {
      "models": ["claude", "gpt", "gemini"],
      "systemPrompt": "You are reviewing code for quality, bugs, and design issues.",
      "thinking": "high",
      "memberTimeoutMs": 120000
    }
  },
  "defaultProfile": "default",
  "systemPrompt": "You are one member of a multi-model council. Multiple AI models have been given the same question independently. Your job is to provide YOUR perspective — do your own research, form your own opinion, and be specific.\n\nRules:\n- Work independently. Do NOT try to coordinate with other models.\n- Do NOT spawn other agents or run council commands.\n- Use your tools to investigate if the question is about code, files, or data.\n- Be concise and specific. Give your actual opinion, not a generic overview.\n- If you disagree with a common assumption, say so clearly and explain why."
}
```

### Customizing

To add a model or profile, read `~/.pi-council/config.json` and edit it directly.
The config supports the full schema above including `systemPrompt` and `memberTimeoutMs` per profile.

## Results location
All run artifacts at `~/.pi-council/runs/<run-id>/`:
- `meta.json` — run metadata (prompt, models, startedAt)
- `prompt.txt` — raw prompt text
- `<member>.json` — per-member result (written as each finishes)
- `results.json` — combined result (written when all done)
- `results.md` — human-readable combined result

## Key design
- Each model is a separate pi instance with independent context via RPC
- Models do their own research — they are NOT given the same evidence
- The orchestrator can send follow-ups (steer/abort) to redirect members mid-flight
- The point is surfacing **disagreement**, not consensus
- The orchestrator synthesizes the final answer from diverse perspectives
- Per-member results are written to disk immediately — they survive context compaction

## IMPORTANT: Do NOT poll after spawning
Results are auto-delivered as followUp messages — each member's output arrives as it finishes,
and a final summary arrives when all are done. After calling spawn_council, continue your other
work or wait for the followUps. Do NOT call council_status or read_stream in a polling loop.
Only use those tools if something seems stuck (>60s with no results) or the user explicitly asks.
