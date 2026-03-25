# Autoresearch Ideas

## Fixed (done)
- ~~`child.pid` undefined crash~~ — guard + throw
- ~~`killPid` busy-wait with Atomics~~ — async setTimeout
- ~~NO_COLOR / stderr color detection~~ — checks both streams + NO_COLOR env
- ~~Extension ignores AbortSignal~~ — wired up signal.abort
- ~~Cancel council spams chat~~ — cancelled flag guard
- ~~Config validation~~ — type checks on all fields
- ~~fs.watch reparse storm~~ — isAgentDone fast-path
- ~~list reparses all JSONL~~ — uses results.json for completed runs
- ~~resolveModels error swallowed~~ — surfaces actual error
- ~~activeRuns leak in extension~~ — cleanup in all paths
- ~~Code duplication ask/spawn/extension~~ — createRun() helper
- ~~Partial text treated as success~~ — uses exit code from .done file
- ~~CLI arg parser broken with flags first~~ — proper two-pass parsing
- ~~Process group kill danger~~ — direct PID kill only + isPiProcess guard
- ~~No tests~~ — 40 unit tests for parser, config, pid, run-state, run-id
- ~~No timeout~~ — config.timeout_seconds (default 300s), --timeout CLI flag, extension timeout

## Remaining ideas
- **Extension imports fragile ../../src/ paths** — works but fragile if restructured
- **Prompt passed as CLI arg** — visible via `ps aux`, could use stdin/file instead
- **fs.watch unreliable on some platforms** — interval fallback exists but fs.watch is primary
- **stream-parser reads entire file into memory** — fine for now, could use incremental parsing for huge streams
- **watch/results double-resolve race** — add boolean guard in done()
- **Extension non-interactive polls instead of using child events** — minor latency
- **No graceful disk-full handling** — try/catch with clear error messages
