# pi-council v2 Improvement Ideas

## Done ✅
- RPC member integration tests
- Bias prevention prompt guidelines
- Intermediate delivery (every member, including last)
- Process lifecycle: spawn failure, cancel, crash (MOCK_PI_FAIL), slow member
- Concurrent council tests
- Error stream capture (stderr in member.ts)
- Tool execution event propagation (MOCK_PI_TOOL_CALLS)
- Docker sandbox (--network none, tmpfs, non-root)
- Dynamic path resolution ($HOME override works)

## Next up
- **Steer during active processing** — use mock-pi-slow to send steer while member is working, verify it gets delivered
- **Abort + re-prompt** — abort a slow member and send new prompt, verify new output replaces old
- **Member stderr surfacing** — expose stderr content through council_status / read_stream
- **CLI integration tests** — test `pi-council ask` command works end-to-end with mock-pi binary override

## Future
- **Per-model role specialization** — different system prompts per model to force diversity
- **Cost tracking** — aggregate token usage / cost across members via get_session_stats
- **2-model escalation** — start with 2 models, add a 3rd only if they disagree
