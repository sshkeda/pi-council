# pi-council v2 Improvement Ideas

## Done ✅
- RPC member integration tests
- Bias prevention prompt guidelines
- Intermediate delivery (every member, including last)
- Process lifecycle: spawn failure, cancel, crash, slow member
- Concurrent council tests
- Tool execution event propagation
- Docker sandbox (--network none, tmpfs, non-root)
- Dynamic path resolution ($HOME override)
- Live steer/abort during active processing
- RPC command timeout (10s)
- Fixed member hang (keepAlive removed)

## Next up
- **Member stderr surfacing** — expose stderr content through council_status / read_stream
- **Agreement snapshot** — after all members respond, detect if they agree/disagree and surface it in the final summary
- **Cost tracking** — aggregate token usage across members via get_session_stats RPC command

## Future
- **Per-model role specialization** — different system prompts per model to force diversity  
- **2-model escalation** — start with 2 models, add a 3rd only if they disagree
