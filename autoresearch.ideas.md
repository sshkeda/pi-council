# pi-council v2 Improvement Ideas

## Done ✅ (200 tests)
- RPC-based members with bidirectional communication
- Follow-ups: steer + abort (live, during processing, targeted)
- Cancel individual member or entire council
- Full observability: status, stream, stderr, events, cost/tokens
- Docker sandbox (--network none, tmpfs, non-root)
- Streaming partial responses verified
- Per-model system prompt overrides
- Config file for custom models + systemPrompt
- CLI E2E tests (all commands)
- Extension integration tests (mock ExtensionAPI)
- Ground truth artifacts (results.json)

## Next up
- **Cost aggregation in results** — query get_session_stats before closing stdin, include in results.json
- **CLI `ask --json`** — output structured JSON instead of markdown for script consumption
- **Extension noninteractive path with mock-pi** — test spawn_council blocking mode end-to-end

## Future  
- **2-model escalation** — start with 2, add 3rd if they disagree
