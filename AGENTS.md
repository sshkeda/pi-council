# pi-council

Multi-model council tool. Spawns different AI models in parallel for independent opinions via RPC.

## Architecture

Each council member is a `pi --mode rpc` process with bidirectional stdin/stdout communication.
Core: `src/core/council.ts` (Council manager), `src/core/member.ts` (RPC member), `src/core/types.ts`, `src/core/profiles.ts`, `src/core/config.ts`.
Extension: `extensions/pi-council/index.ts` (spawn_council, council_followup, cancel_council, council_status, read_stream).
Tests: `tests/council.test.mjs` (deterministic tests using `tests/mock-pi.mjs`).

## Usage

```txt
# As pi extension tools
spawn_council({ question: "your question" })
spawn_council({ question: "your question", profile: "my-profile" })
spawn_council({ question: "your question", models: ["claude", "grok"] })
council_status({ runId: "..." })
read_stream({ runId: "...", memberId: "claude" })

# Via MCPorter
mcporter call pi-council.spawn_council question='your question'
mcporter call pi-council.council_status runId='...'
mcporter call pi-council.read_council_results runId='...' wait=true

# Configuration
# Edit ~/.pi-council/config.json directly for model/profile changes
```

Default models: `claude`, `gpt`, `gemini`, `grok`
Config: `~/.pi-council/config.json` (models map + named profiles + defaultProfile)

## Key design

- Each model is a separate pi agent with its own tools via RPC
- Models do their own independent research
- The orchestrator can send follow-ups (steer/abort) mid-flight
- The point is surfacing **disagreement**, not consensus
- The orchestrator should prompt neutrally — no bias injection
- Per-member results written to disk as each member finishes
- Config: `~/.pi-council/config.json` with models map, named profiles, defaultProfile
- Profiles support custom system prompts and per-member timeouts
- `--profile <name>` flag on ask/spawn, `profile` param on spawn_council extension tool

