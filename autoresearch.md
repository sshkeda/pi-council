# pi-council Autoresearch Rules

## What we're optimizing
pi-council v2 architecture — RPC-based council with bidirectional communication, follow-ups, and full observability.

## Primary metric
`tests_passed` (higher is better) — number of tests passing in the deterministic test suite.

## How to run
```bash
./autoresearch.sh
```
This builds the project then runs `node tests/council.test.mjs`.

## Architecture goals (v2)
1. **RPC-based members**: Each council member is a `pi --mode rpc` process with stdin/stdout communication
2. **Follow-ups**: Orchestrator can send abort (interrupt + inject) or steer (queue after tool call) to members
3. **Full observability**: Read member streams, status, errors in real-time
4. **Profiles**: Spawn via named profile (max/fast/read-only) or custom config
5. **Unbiased prompting**: Orchestrator strips its own conclusions when formulating council questions
6. **Background/foreground**: Council results arrive via triggerTurn:false, orchestrator's foreground work isn't disrupted
7. **Cancel**: Kill individual members or entire council

## Testing philosophy
- Use mock-pi (tests/mock-pi.mjs) for deterministic testing — zero API calls
- Test the full lifecycle: spawn → follow-up → cancel → status → results
- Test error paths: spawn failure, process crash, timeout
- Test RPC protocol compliance: steer, abort, get_state

## Rules
- Fix bugs in src/ to make tests pass — do NOT weaken tests
- If a test is flawed, fix the test but keep the scenario strict
- Don't hardcode mock expectations into src/
- Keep mock-pi realistic — it should speak the real pi RPC protocol
- Architecture changes should reduce complexity, not add it
