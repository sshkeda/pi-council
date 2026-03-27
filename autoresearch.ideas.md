# pi-council v2 Improvement Ideas

## Done ✅
- RPC member integration tests (T21-T30, T51-T55)
- Timeout enforcement (T39)
- Bias prevention prompt guidelines (skill file updated)
- Intermediate delivery (extension delivers per-member followUps)
- Process lifecycle tests: spawn failure (T28/T48), cancel (T24/T25), timeout (T39)
- Concurrent council tests (T49)
- Error stream capture (stderr collected in member.ts)

## Next up
- **Mock-pi crash test** — test MOCK_PI_FAIL=true env var for simulated crashes
- **Tool execution event tests** — verify member_tool_start/end events fire with mock-pi tool calls
- **SDK-based testing** — use createAgentSession() with mock provider for deeper testing without process spawning
- **Configurable triggerTurn** — let orchestrator choose whether final result interrupts foreground work

## Future
- **Per-model role specialization** — different system prompts per model to force diversity
- **Cost tracking** — aggregate token usage / cost across members via get_session_stats
- **2-model escalation** — start with 2 models, add a 3rd only if they disagree
- **Mock provider via streamSimple** — create a mock provider extension for SDK-based tests
