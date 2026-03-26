# pi-council Autoresearch Rules

## What we're optimizing
pi-council correctness and robustness, measured by an automated benchmark suite of 18 end-to-end tests.

## Primary metric
`tests_passed` (higher is better) — number of benchmark tests that pass out of 18 total.

## How to run
```bash
./autoresearch.sh
```
This builds the project then runs `node tests/benchmark/run-benchmarks.mjs`.

## Benchmark design
- Each test gets an **isolated HOME directory** (no cross-test contamination)
- A **mock `pi` binary** (`tests/benchmark/mock-pi`) replaces the real `pi` command
- Mock supports 12 behaviors: success, error, partial, crash, slow, stall, large, malformed, tooluse, multiend, empty, silent_crash
- Per-model behavior via `MOCK_BEHAVIOR_<model>=<behavior>` env vars
- Tests validate: file creation, JSON correctness, exit codes, process lifecycle, error handling

## Test scenarios
| ID   | Tests | What could break |
|------|-------|-----------------|
| T01  | 4-model success | Basic happy path, results.json/md generation |
| T02  | --models filter | Model resolution, file isolation |
| T03  | 1 model errors | Error isolation, partial success |
| T04  | All models fail | Total failure handling |
| T05  | Partial output (no message_end) | Stream parser fallback to assistantText |
| T06  | Malformed JSONL lines | Parser resilience to corruption |
| T07  | 1000-event large output | Memory, stream file size |
| T08  | Tool call counting | toolCall parts in message_end |
| T09  | Usage accumulation | Multi-message_end cost/token summing |
| T10  | Stall detection | stall_seconds timing, status reporting |
| T11  | Cancel kills PIDs | Process cleanup, .done file creation |
| T12  | Cleanup removes files | Directory deletion, latest-run-id update |
| T13  | Concurrent runs | Run isolation, no cross-contamination |
| T14  | Empty output | Zero-byte stream detection |
| T15  | Spawn + results wait | Background spawn, results blocking |
| T16  | Unknown model rejection | Config validation |
| T17  | Process crash (exit 1) | No-output crash recovery |
| T18  | Silent crash (partial + exit 1) | Partial write + crash detection |

## Rules
- Fix bugs in src/ to make tests pass — do NOT weaken tests
- If a test is flawed (race condition in test logic), fix the test but keep the scenario strict
- Don't hardcode mock expectations into src/ — the mock simulates real pi behavior
- Keep the mock realistic — it should produce the same JSONL structure real pi does
