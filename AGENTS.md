# pi-council

Multi-model council tool. Spawns different AI models in parallel for independent opinions via RPC.

## Architecture

Each council member is a `pi --mode rpc` process with bidirectional stdin/stdout communication.
Core: `src/core/council.ts` (Council manager), `src/core/member.ts` (RPC member), `src/core/types.ts`, `src/core/profiles.ts`, `src/core/config.ts`.
Extension: `extensions/pi-council/index.ts` (spawn_council, council_followup, cancel_council, council_status, read_stream).
Tests: `tests/council.test.mjs` (deterministic tests using `tests/mock-pi.mjs`).

## Usage

```bash
pi-council ask "your question"
pi-council ask --models claude,grok "your question"
pi-council ask --json "your question"
pi-council spawn "your question"
pi-council status
pi-council status --json
pi-council watch
pi-council results
pi-council list
pi-council list --json
pi-council cleanup
```

Available models: `claude`, `gpt`, `gemini`, `grok`

## Key design

- Each model is a separate pi agent with its own tools via RPC
- Models do their own independent research
- The orchestrator can send follow-ups (steer/abort) mid-flight
- The point is surfacing **disagreement**, not consensus
- The orchestrator should prompt neutrally — no bias injection
- Per-member results written to disk as each member finishes
- Config customizable via `~/.pi-council/config.json`
