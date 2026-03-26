# Autoresearch: pi-council — Final Report

## Journey
- **Phase 1** (batches 1-22): Subjective LLM code review → 24 issues at 6.4 avg → ~3 issues at 7.5-8.0 avg
- **Phase 2** (council pivot): Designed deterministic benchmark per council recommendations
- **Phase 3** (current): 102 tests, 75+ fixes, fully deterministic scenario suite

## Stats
- **Tests:** 102 (76 unit + 26 scenario)
- **Fixes:** 75+
- **Runtime deps:** 0
- **Test duration:** 3.5s
- **Mock pi behaviors:** 9 (success, error, hang, partial, malformed, large, crash, slow, empty)

## Scenario Coverage
1. Basic success (spawn → parse → artifacts)
2. Error handling (stopReason=error)
3. Large output (1000+ events)
4. Malformed JSONL (bad lines mixed with good)
5. Crash with partial output
6. Timeout enforcement
7. Cancellation
8. Empty output
9. State machine truth table (6 state combinations)
10. Multi-model mixed outcomes
11. Parser adversarial (non-pi JSON, CRLF, empty lines, unicode)
12. Stall detection (mtime-based)
13. Comprehensive state machine (5 additional states)

## Remaining ideas (low priority)
- Orphan rate test (spawn+kill parent, count survivors)
- Concurrent runs test (two councils in parallel)
- Extension test with mocked ExtensionAPI
- Concurrent cleanup+results race condition test
