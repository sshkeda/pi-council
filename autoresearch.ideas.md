# pi-council v2 Improvement Ideas

## Done ✅ (185 tests)
- RPC-based members with bidirectional communication
- Follow-ups: steer + abort (live, during processing, targeted)
- Cancel individual member or entire council
- Full observability: status, stream, stderr, events, cost/tokens
- Docker sandbox (--network none, tmpfs, non-root)
- Streaming partial responses verified
- Per-model system prompt overrides
- Config file for custom models
- CLI E2E tests (ask/status/results/list/cleanup)
- Ground truth artifacts (results.json, no .done markers)

## Next up
- **Extension integration harness** — mock ExtensionAPI to test spawn_council/council_followup tool execution
- **CLI watch live streaming** — stream partial output to terminal as members produce text (currently just waits for results.json)
- **Cost aggregation** — after completion, query get_session_stats from all members and include total cost in results

## Future
- **2-model escalation** — start with 2, add 3rd if they disagree
