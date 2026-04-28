# pi-council agent notes

pi-council spawns independent `pi --mode rpc` member processes and collects their answers for comparison. Keep docs concise and avoid duplicating README prose here.

## Main files

- `src/core/council.ts` — run lifecycle, member orchestration, persistence, follow-ups, cancellation.
- `src/core/member.ts` — RPC process wrapper for one `pi` member.
- `src/core/config.ts` — `~/.pi-council/config.json` loading, validation, profile/model resolution.
- `src/core/runs.ts` and `src/core/storage.ts` — persisted run lookup and cleanup.
- `src/core/types.ts` — shared public types.
- `extensions/pi-council/index.ts` — pi extension tools and status widget.
- `src/mcp/server.ts` — MCP tool server.
- `skills/pi-council/SKILL.md` — skill instructions shown to pi agents.
- `config.default.json` and `config.schema.json` — user config template and schema.

## Public tools

Pi extension:

```txt
spawn_council({ question, profile?, models?, label? })
council_followup({ message, type, runId?, memberIds? })
cancel_council({ runId?, memberIds? })
council_status({ runId? })
read_council_stream({ runId?, memberId })
```

MCP also exposes:

```txt
list_council_runs({})
read_council_results({ runId?, wait?, timeoutMs? })
cleanup_council_runs({ runId? | all? })
```

## Runtime behavior

- Config is read from `~/.pi-council/config.json`; there is no config CLI.
- Profiles select model IDs from the top-level `models` map and may set `systemPrompt`, `thinking`, and `memberTimeoutMs`.
- Deprecated top-level `systemPrompt` is still used as a fallback for profiles without one.
- Model names are passed through unchanged; use concrete model IDs from the local pi install.
- Run artifacts are stored in `~/.pi-council/runs/<run-id>/`.
- Members are launched with `PI_COUNCIL_MEMBER=1`; the extension must not register council tools in that environment.

## Design rules

- Preserve model independence. Do not share one member's analysis with another unless the user explicitly sends a follow-up.
- Prompt neutrally. The council's value is disagreement, not confirmation of the orchestrator's opinion.
- Do not poll after spawning in interactive sessions; results are auto-delivered.
- Persist per-member results as soon as each member finishes.
- Avoid adding hard-coded model defaults in TypeScript; use `config.default.json` for templates.

## Tests

```bash
npm run build
npm test
npm run test:e2e
```

Current e2e scripts run extension and MCP coverage. The old UI ownership test was removed.
