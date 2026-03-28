# pi-council v2 — Done

## Shipped ✅
- RPC-based members with bidirectional communication (pi --mode rpc)
- Follow-ups: steer (queue after tool call) + abort (interrupt immediately)
- Cancel individual member or entire council
- Full observability: status, stream, stderr, events, cost/tokens, TTFR
- Per-model system prompt overrides
- Config file (~/.pi-council/config.json) for custom models
- --json flag for all CLI commands (ask, status, list, results)
- SIGINT clean shutdown
- Docker sandbox testing (--network none, non-root)
- Extension integration (5 tools: spawn_council, council_followup, cancel_council, council_status, read_stream)
- Unbiased prompting guidelines in skill file
- Cost tracking via get_session_stats RPC
- Agreement snapshot in intermediate delivery

## If needed later
- 2-model escalation — start with 2, add 3rd if they disagree
- Watch live streaming — stream partial output to terminal as members produce text
