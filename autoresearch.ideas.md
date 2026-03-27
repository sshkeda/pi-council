# pi-council v2 Improvement Ideas

## Done ✅ (100 tests)
- RPC-based members with bidirectional communication
- Follow-ups: steer + abort (live, during processing)
- Cancel individual member or entire council
- Full observability: status, stream, stderr, events
- Docker sandbox (--network none, tmpfs, non-root)
- Cost tracking via getSessionStats RPC
- Mock-pi variants: crash, slow, tool-calls
- Orchestrator patterns tested end-to-end

## Next up
- **Extension tool contract tests** — verify spawn_council/council_followup/cancel_council/council_status/read_stream return correct shapes
- **Agreement snapshot in final delivery** — detect basic agree/disagree across members and surface it
- **Hurry-up pattern** — orchestrator sends steer("wrap up quickly") to all members after N seconds

## Future
- **Per-model role specialization** — different system prompts per model to force diversity
- **2-model escalation** — start with 2 models, add a 3rd only if they disagree
