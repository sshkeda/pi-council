# pi-council

Multi-model council tool. Spawns different AI models in parallel for independent opinions via RPC.

## Architecture

Each council member is a `pi --mode rpc` process with bidirectional stdin/stdout communication.
Core: `src/core/council.ts` (Council manager), `src/core/member.ts` (RPC member), `src/core/types.ts`, `src/core/profiles.ts`.
Extension: `extensions/pi-council/index.ts` (spawn_council, council_followup, cancel_council, council_status, read_stream).
Tests: `tests/council.test.mjs` (deterministic tests using `tests/mock-pi.mjs`).

## Usage

```bash
pi-council ask "your question"
pi-council spawn "your question"
pi-council status
pi-council watch
pi-council cleanup
pi-council list
```

## Select models

```bash
pi-council ask --models claude,gpt "your question"
```

## Profiles

```bash
pi-council ask --profile fast "quick question"   # 2 models
pi-council ask --profile read-only "review this"  # no bash
pi-council ask --profile max "deep analysis"      # all 4, default
```

Available models: `claude`, `gpt`, `gemini`, `grok`

## Key design

- Each model is a separate pi agent with its own tools via RPC
- Models do their own independent research
- The orchestrator can send follow-ups (steer/abort) mid-flight
- The point is surfacing **disagreement**, not consensus
- The orchestrator should prompt neutrally — no bias injection
