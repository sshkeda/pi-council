# pi-council — Multi-Model AI Council

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

> Spawn Claude, GPT, Gemini, and Grok as independent pi agents to get parallel, unbiased opinions. The orchestrator gets richer context from diverse perspectives to make better decisions.

## Why

One model can be wrong. Different models are wrong about **different things**. By getting 4 independent opinions, the orchestrator has much richer signal to work with — the differing opinions are the product.

## Core Principles

1. **Unbiased prompting** — The orchestrator strips its own conclusions when querying the council. No leading questions.
2. **Independent research** — Each model works alone with its own tools. They're not given the same evidence.
3. **Disagreement is signal** — The value is in the differences, not consensus. Pay attention to the dissenter.
4. **Background operation** — Council runs in background, orchestrator continues foreground work. Results arrive without disruption.

## Install

```bash
pi install https://github.com/sshkeda/pi-council.git
```

## Extension Tools

When installed as a pi package, the orchestrator gets these tools:

### `spawn_council`
Spawn models in parallel. Returns immediately.

```
spawn_council({ question: "Should we use microservices?" })
spawn_council({ question: "Review this PR", profile: "code-review" })
spawn_council({ question: "Quick check", models: ["claude", "gpt"] })
```

- `question` — The question, framed neutrally
- `profile` — Optional: named profile from config (e.g. `"quick"`, `"code-review"`)
- `models` — Optional: explicit model IDs (overrides profile)

### `council_followup`
Send a follow-up to running members.

```
council_followup({ type: "steer", message: "Also consider the latency impact" })
council_followup({ type: "abort", message: "New info: the budget changed", memberIds: ["claude"] })
```

- `type: "steer"` — Queued after current tool call completes
- `type: "abort"` — Interrupts immediately, injects new context

### `cancel_council`
Kill members or entire council.

### `council_status`
Get per-member state: running, done, failed, elapsed time, streaming status, stderr, output preview.

### `read_stream`
Read a member's full accumulated output, stderr, and debug info.

## CLI

```bash
# Ask
pi-council ask "Should I refactor this module?"
pi-council ask --profile quick "Fast review"
pi-council ask --models claude,grok "Quick review"
pi-council ask --json "Structured output"

# Spawn & monitor
pi-council spawn "Analyze MSFT"
pi-council status [--json]
pi-council list [--json]
pi-council results [--json]
pi-council watch
pi-council cleanup
pi-council cleanup --all

# Configuration
pi-council config                   # Show current config
pi-council config path              # Print config file path
pi-council config init              # Create default config
```

## Architecture

Each council member is a `pi --mode rpc` process with stdin/stdout bidirectional communication:

```
Orchestrator                     Council Members (background)
    │                                │
    ├── spawn_council ──────────────►│ claude (pi --mode rpc)
    │                                │ gpt    (pi --mode rpc)
    │                                │ gemini (pi --mode rpc)
    │                                │ grok   (pi --mode rpc)
    │                                │
    ├── (continues foreground work)  │ (independent research)
    │                                │
    ├── council_followup(steer) ────►│ (queued for after tool call)
    ├── council_followup(abort) ────►│ (immediate interrupt)
    │                                │
    │◄─── member result (each) ─────│ (triggerTurn: false)
    │◄─── summary (all done) ───────│ (triggerTurn: true)
```

## Results

Artifacts at `~/.pi-council/runs/<run-id>/`:
- `meta.json` — run metadata
- `prompt.txt` — raw prompt
- `<member>.json` — per-member result (written immediately on completion)
- `results.json` — combined structured results
- `results.md` — human-readable combined results

## Configuration

Config lives at `~/.pi-council/config.json`. Run `pi-council config init` to create it.

```json
{
  "models": {
    "claude": { "provider": "anthropic", "model": "claude-opus-4-6" },
    "gpt": { "provider": "openai-codex", "model": "gpt-5.4" },
    "gemini": { "provider": "google", "model": "gemini-3.1-pro-preview" },
    "grok": { "provider": "xai", "model": "grok-4.20-0309-reasoning" }
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
  "defaultProfile": "default"
}
```

**Models** define available AI models by ID → provider/model. **Profiles** are named sets of models with optional system prompt, thinking level (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`), and timeout. Use `--profile` to switch:

```bash
pi-council ask --profile quick "Fast check"
pi-council ask --profile code-review "Review auth.ts"
```



## Development

```bash
npm run build        # TypeScript compile
npm run dev          # Run CLI via tsx
```

## License

MIT
