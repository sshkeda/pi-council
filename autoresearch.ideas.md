# pi-council v2 Improvement Ideas

## Done ✅ (163 tests)
- RPC-based members with bidirectional communication
- Follow-ups: steer + abort (live, during processing, targeted)
- Cancel individual member or entire council  
- Full observability: status, stream, stderr, events, cost/tokens
- Docker sandbox (--network none, tmpfs, non-root)
- Mock-pi variants: crash, slow, tool-calls, custom output
- Agreement snapshot in intermediate delivery
- Per-model system prompt overrides
- Config file (~/.pi-council/config.json) for custom models
- CLI E2E tests with PI_COUNCIL_PI_BINARY
- Dynamic path resolution in all CLI commands

## Next up
- **CLI `status` E2E test** — verify status command works on a completed run
- **CLI `results` E2E test** — verify results command reads artifacts
- **Extension integration test** — mock the pi ExtensionAPI and test spawn_council tool  
- **Config in extension** — extension should also read config for model defaults

## Future
- **2-model escalation** — start with 2 models, add a 3rd only if they disagree
- **Watch live streaming** — CLI watch with real-time output as members produce text
