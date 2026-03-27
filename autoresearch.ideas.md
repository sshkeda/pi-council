# pi-council v2 Improvement Ideas

## Done ✅ (213 tests)
- RPC-based members, steer/abort follow-ups, cancel, observability
- Docker sandbox, streaming partial responses, per-model prompts
- Config file, CLI E2E, extension integration tests
- Cost tracking (get_session_stats), ground truth artifacts
- --json flag for ask and status, SIGINT handler

## Next up
- **list --json** — structured JSON for list command
- **results --json** — structured JSON for results command
- **TTFR tracking** — time-to-first-result in CouncilResult
- **Council.toJSON()** — serializable snapshot for debugging

## Future
- **2-model escalation** — start with 2, add 3rd if they disagree
