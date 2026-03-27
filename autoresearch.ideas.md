# pi-council v2 Improvement Ideas

## Done ✅ (140 tests)
- RPC-based members with bidirectional communication
- Follow-ups: steer + abort (live, during processing, targeted)
- Cancel individual member or entire council
- Full observability: status, stream, stderr, events, cost/tokens
- Docker sandbox (--network none, tmpfs, non-root)
- Mock-pi variants: crash, slow, tool-calls, custom output
- Agreement snapshot in intermediate delivery
- 140 deterministic tests covering all feature paths

## Next up
- **Per-model system prompt override** — let orchestrator customize what each model focuses on
- **CLI end-to-end tests** — test `pi-council ask` with mock-pi binary override via env var
- **Extension tool parameter validation** — test that invalid params return proper errors

## Future
- **2-model escalation** — start with 2 models, add a 3rd only if they disagree
- **Configurable model list** — load from `~/.pi-council/config.json`
