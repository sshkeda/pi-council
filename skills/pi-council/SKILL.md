---
name: pi-council
description: >
  Spawn multiple AI models (Claude, GPT, Gemini, Grok, or any configured model IDs)
  as independent pi agents. Use for diverse perspectives on architecture decisions,
  code review, product strategy, research, or other high-stakes questions.
version: 0.1.1
license: MIT
---

# pi-council

Use pi-council when independent model opinions are more valuable than one synthesized answer. Each council member is a separate `pi --mode rpc` process with its own tools and context.

## Critical rule: prompt neutrally

The council only works if members are not led toward your preferred answer.

Do:
- Present the raw question, constraints, relevant files/data, and decision criteria.
- Ask open-endedly: "What approach do you recommend and why?"
- Include uncertainty and tradeoffs.

Do not:
- Include your own conclusion or preferred solution.
- Frame the prompt to validate one answer.
- Hide important context that weakens one option.

## Tools

### spawn_council

Spawns a council. In interactive sessions it returns immediately; results are delivered automatically as each member finishes and again as a final summary.

Parameters:
- `question` (required): neutral council prompt.
- `profile` (optional): named profile from `~/.pi-council/config.json`; omit to use `defaultProfile`.
- `models` (optional): explicit model IDs, e.g. `["claude", "gpt"]`; overrides profile model selection.
- `label` (optional): short status-widget label.

### council_followup

Sends more context to running members.

Parameters:
- `message` (required): follow-up text.
- `type` (required): `"steer"` queues after the current tool call; `"abort"` interrupts and redirects.
- `runId` (optional): target run; omit for latest live run.
- `memberIds` (optional): target members; omit for all running members.

### cancel_council

Cancels a live council or selected members.

### council_status

Shows detailed live status. Use only if something appears stuck or the user explicitly asks. Do not poll after `spawn_council`.

### read_council_stream

Reads a member's accumulated output/thinking/stderr. Use only to re-read a result or when the user asks; normal results are auto-delivered.

## Configuration

Config file: `~/.pi-council/config.json`.

Template/schema files in the package:
- `config.default.json`
- `config.schema.json`

Shape:

```json
{
  "models": {
    "<id>": { "provider": "<pi-provider>", "model": "<model-name>" }
  },
  "profiles": {
    "<name>": {
      "models": ["<id>"],
      "systemPrompt": "optional member system prompt",
      "thinking": "off | minimal | low | medium | high | xhigh",
      "memberTimeoutMs": 120000
    }
  },
  "defaultProfile": "<name>"
}
```

Rules:
- Every profile model ID must exist in `models`.
- `defaultProfile` must name an existing profile.
- A deprecated top-level `systemPrompt` still works as fallback for profiles without `systemPrompt`.
- If no profile/top-level prompt is set, members receive no extra council system prompt.

Model names are passed to pi unchanged. Use concrete model IDs supported by the user's local `pi --list-models` output.

## Results

Artifacts are written to `~/.pi-council/runs/<run-id>/`:
- `meta.json`
- `prompt.txt`
- `<member>.json`
- `results.json`
- `results.md`

## Operating guidance

- After spawning, continue foreground work or wait for auto-delivered follow-ups.
- Do not call `council_status`/`read_council_stream` in a polling loop.
- Pay attention to dissenting members; disagreement is often the useful signal.
- Council members cannot spawn nested councils because child sessions run with `PI_COUNCIL_MEMBER=1` and council tools are not registered.
