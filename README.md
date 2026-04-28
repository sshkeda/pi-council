# pi-council

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

Spawn multiple `pi --mode rpc` agents in parallel and compare their independent answers. pi-council is packaged as both a pi extension and an MCP server.

## Why use it?

Single-model answers can hide uncertainty. A council keeps each model isolated, lets members use their own tools, and surfaces disagreement instead of forcing consensus too early.

Use it for architecture decisions, code review, product strategy, incident analysis, research questions, or any high-stakes call where independent perspectives are useful.

## Install

### pi extension

```bash
pi install https://github.com/sshkeda/pi-council.git
```

This registers these pi tools:

- `spawn_council`
- `council_followup`
- `cancel_council`
- `council_status`
- `read_stream`

### MCP server

```bash
npm install
npm run build
mcporter config add pi-council \
  --scope home \
  --command node \
  --arg /absolute/path/to/pi-council/dist/src/mcp/server.js
```

For long-running councils across multiple MCP calls, configure MCPorter as keep-alive and run the daemon:

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

If the package binary is on your `PATH`, you can use:

```bash
mcporter config add pi-council --scope home --command pi-council-mcp
```

## Configure

Runtime config lives at:

```text
~/.pi-council/config.json
```

There is intentionally no config CLI. Copy `config.default.json`, replace the placeholder providers/models with model IDs available in your pi install, and edit profiles directly.

Minimal shape:

```json
{
  "$schema": "https://raw.githubusercontent.com/sshkeda/pi-council/main/config.schema.json",
  "models": {
    "claude": { "provider": "your-claude-provider", "model": "your-claude-model" },
    "gpt": { "provider": "your-gpt-provider", "model": "your-gpt-model" }
  },
  "profiles": {
    "default": {
      "models": ["claude", "gpt"],
      "systemPrompt": "You are one member of a multi-model council. Work independently and give your real opinion."
    }
  },
  "defaultProfile": "default"
}
```

Profile options:

- `models`: model IDs from the top-level `models` map.
- `systemPrompt`: optional prompt appended to each member's system prompt.
- `thinking`: optional pi thinking level: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
- `memberTimeoutMs`: optional per-member timeout in milliseconds.

Backward compatibility: a deprecated top-level `systemPrompt` is still applied to profiles that omit their own prompt.

### Model names

pi-council passes configured model names through to pi unchanged. Use concrete model IDs that your local `pi --list-models` output supports.

## Use

### pi tools

```txt
spawn_council({ question: "Which migration plan is safest?" })
spawn_council({ question: "Review this design", models: ["claude", "gpt"] })
spawn_council({ question: "Assess this incident", profile: "deep", label: "incident review" })

council_followup({ type: "steer", message: "Also consider rollback risk" })
cancel_council({ runId: "20260428-..." })
council_status({ runId: "20260428-..." })
read_stream({ runId: "20260428-...", memberId: "claude" })
```

`spawn_council` returns immediately in interactive pi sessions. Member results are delivered automatically as follow-up messages, and a final summary is sent when everyone finishes. Do not poll `council_status` or `read_stream` unless something appears stuck or you need to re-read a result.

### MCP tools

```bash
mcporter call pi-council.spawn_council --args '{"question":"Which migration plan is safest?"}'
mcporter call pi-council.council_followup --args '{"type":"steer","message":"Also consider rollback risk"}'
mcporter call pi-council.council_status runId='20260428-...'
mcporter call pi-council.read_stream runId='20260428-...' memberId='claude'
mcporter call pi-council.read_council_results --args '{"runId":"20260428-...","wait":true}'
```

Additional MCP-only helpers:

- `list_council_runs`
- `read_council_results`
- `cleanup_council_runs`

## Prompting rule

Ask neutrally. The council is most useful when members receive the raw situation, constraints, and evidence without your preferred answer embedded in the question.

Good:

```txt
We need to choose between approach A and B. Constraints: ... Code: ... What risks and recommendation do you see?
```

Bad:

```txt
I think approach A is obviously cleaner. Tell me why A is better than B.
```

## Results

Run artifacts are written under:

```text
~/.pi-council/runs/<run-id>/
```

Files:

- `meta.json` — run metadata.
- `prompt.txt` — original question.
- `<member>.json` — each member result, written as soon as that member finishes.
- `results.json` — combined machine-readable result.
- `results.md` — combined human-readable result.

## Architecture

```text
pi extension or MCP client
        |
        v
  pi-council runner
        |
        +--> member A: pi --mode rpc --provider ... --model ...
        +--> member B: pi --mode rpc --provider ... --model ...
        +--> member C: pi --mode rpc --provider ... --model ...
```

Important behavior:

- Every member is a separate pi process with independent context.
- Members cannot spawn nested councils; child processes run with `PI_COUNCIL_MEMBER=1`, so council tools are not registered.
- Follow-ups can steer queued work or abort and redirect active work.
- Per-member output is persisted immediately so partial results survive failures or context compaction.

## Development

```bash
npm install
npm run build
npm test
```

Useful scripts:

- `npm run dev:mcp` — run the MCP server from TypeScript.
- `npm run test:profiles`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run test:live`

## License

MIT
