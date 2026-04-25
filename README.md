# pi-council — Multi-Model AI Council

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

> Spawn Claude, GPT, Gemini, and Grok as independent pi agents to get parallel, unbiased opinions.

## Why

One model can be wrong. Different models are wrong about different things. A council gives you richer signal by preserving disagreement instead of collapsing everything into one answer.

## Core principles

1. **Unbiased prompting** — ask neutrally.
2. **Independent research** — each member gets its own tools and context.
3. **Disagreement is signal** — the dissenter matters.
4. **Background execution** — councils can run while the orchestrator keeps working.

## Install

### As a pi package

```bash
pi install https://github.com/sshkeda/pi-council.git
```

This exposes the pi extension tools:
- `spawn_council`
- `council_followup`
- `cancel_council`
- `council_status`
- `read_stream`

### As an MCP server for MCPorter

Build the package, then point MCPorter at the server entrypoint:

```bash
npm install
npm run build
mcporter config add pi-council \
  --scope home \
  --command node \
  --arg /absolute/path/to/pi-council/dist/src/mcp/server.js
```

For live follow-ups, status, and streaming across multiple MCP calls, mark the server as keep-alive and start the daemon:

```json
{
  "mcpServers": {
    "pi-council": {
      "command": "node",
      "args": ["/absolute/path/to/pi-council/dist/src/mcp/server.js"],
      "lifecycle": "keep-alive"
    }
  }
}
```

```bash
mcporter daemon start
```

Once added, MCPorter will expose these MCP tools:
- `spawn_council`
- `council_followup`
- `cancel_council`
- `council_status`
- `read_stream`
- `list_council_runs`
- `read_council_results`
- `cleanup_council_runs`

If you install this package somewhere on your `PATH`, you can use the bundled bin instead:

```bash
mcporter config add pi-council --scope home --command pi-council-mcp
```

## Configuration

Runtime config lives at:

```text
~/.pi-council/config.json
```

There is no pi-council CLI anymore. Create or edit the config file directly. You can start from `config.default.json`.

### Example

```json
{
  "$schema": "https://raw.githubusercontent.com/sshkeda/pi-council/main/config.schema.json",
  "models": {
    "claude": { "provider": "claude-code", "model": "claude-opus-4-6" },
    "gpt": { "provider": "openai-codex", "model": "gpt-latest-thinking" },
    "gemini": { "provider": "google", "model": "gemini-3.1-pro-preview" },
    "grok": { "provider": "xai", "model": "grok-4.20-reasoning" }
  },
  "profiles": {
    "default": {
      "models": ["claude", "gpt", "gemini", "grok"],
      "systemPrompt": "You are one member of a multi-model council. Work independently, use your tools, and give your real opinion."
    }
  },
  "defaultProfile": "default"
}
```

`gpt-latest-thinking` is resolved at spawn time to the newest thinking-capable `openai-codex` GPT model from `pi --list-models gpt`. This resolver is intentionally narrow: it does not auto-resolve Gemini, Grok, Claude, OpenRouter GPTs, or arbitrary provider "latest" aliases. Pi's thinking shorthand is preserved, e.g. `gpt-latest-thinking:high`.

If you want Claude to run through the `claude-code` provider, install the companion provider package:

```bash
pi install /absolute/path/to/pi-claude-code
```

## Using the pi extension

```txt
spawn_council({ question: "Should we split this package?" })
council_followup({ type: "steer", message: "Also consider maintenance cost" })
cancel_council({ runId: "20260413-..." })
council_status({ runId: "20260413-..." })
read_stream({ runId: "20260413-...", memberId: "claude" })
```

## Using via MCPorter

```bash
mcporter call pi-council.spawn_council --args '{"question":"Should we split this package?"}'
mcporter call pi-council.council_status runId='20260413-...'
mcporter call pi-council.read_stream runId='20260413-...' memberId='claude'
mcporter call pi-council.read_council_results --args '{"runId":"20260413-...","wait":true}'
```

## Architecture

Each council member is a separate `pi --mode rpc` process.

```text
orchestrator / MCP client
        |
        +--> pi-council
                +--> claude  (pi --mode rpc)
                +--> gpt     (pi --mode rpc)
                +--> gemini  (pi --mode rpc)
                +--> grok    (pi --mode rpc)
```

## Results

Artifacts are written to:

```text
~/.pi-council/runs/<run-id>/
```

Files:
- `meta.json`
- `prompt.txt`
- `<member>.json`
- `results.json`
- `results.md`

## Development

```bash
npm run build
npm run dev:mcp
npm test
```

## License

MIT
