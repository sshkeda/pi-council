# pi-council v2 Improvement Ideas

## Architecture (in progress)
- **RPC member integration tests** — spawn mock-pi, test full steer/abort/follow-up lifecycle
- **Timeout enforcement** — member.spawn() should enforce timeoutSeconds via setTimeout + cancel
- **Error stream capture** — collect stderr from pi processes and surface via council_status
- **SDK-based testing** — use createAgentSession() with mock provider + SessionManager.inMemory() for deeper testing without process spawning

## Extension
- **Bias prevention prompt guidelines** — skill file should teach orchestrator to strip opinions from council questions
- **Intermediate delivery** — deliver each member's result as followUp as soon as it finishes (triggerTurn: false)
- **Configurable triggerTurn** — let orchestrator choose whether final result interrupts foreground work

## Testing
- **Mock provider via streamSimple** — create a mock provider extension that returns canned responses for SDK-based tests
- **Process lifecycle tests** — test spawn failure (ENOENT), crash (exit code != 0), timeout, SIGTERM handling
- **Concurrent council tests** — multiple councils running simultaneously shouldn't interfere

## Future
- **Per-model role specialization** — different system prompts per model to force diversity
- **Cost tracking** — aggregate token usage / cost across members via get_session_stats
- **2-model escalation** — start with 2 models, add a 3rd only if they disagree
