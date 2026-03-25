# Autoresearch Ideas

## Pre-council observations (manual scan)
- **18+ empty catch blocks** — swallowed errors make debugging impossible
- **`any` type** in stream-parser.ts line 41 — should be typed
- **Sync file I/O everywhere** (readFileSync/writeFileSync) — blocks event loop during parsing
- **No input validation** on JSONL parsing — malformed files silently ignored
- **No timeout on `ask` command** — hangs forever if an agent stalls
- **fs.watch + setInterval polling** in results.ts/watch.ts — potential resource leak if promise rejects
- **No graceful SIGINT handling** — Ctrl+C during `ask` leaves orphaned agent processes
- **stream-parser reads entire file into memory** — could be problematic with large JSONL streams
- **No tests** — zero test coverage
- **`killPid` uses busy-wait with Atomics.wait** — unusual pattern, could use setTimeout
- **Extension duplicates some spawn logic** vs shared core — potential for drift
- **No config validation** — malformed config.json silently falls back to defaults
- **`list` command** re-parses all JSONL streams just to show status — expensive for many runs

## Council suggestions (to be filled after council runs)

- **`npm test` emits `node:test run() is being called recursively` warning** — likely test runner/tsx invocation mismatch; cleanup would improve CI signal
