# pi-council

Spawn different AI models in parallel to get independent opinions. Powered by [pi](https://github.com/badlogic/pi-mono).

## Why

One model can be wrong. Different models are wrong about different things. The point isn't consensus — it's surfacing **disagreement** so you (or your orchestrator) can make a better decision.

## Install

```bash
npm install -g pi-council
```

Or via pi:

```bash
pi install npm:pi-council
```

Requires [pi](https://github.com/badlogic/pi-mono) and configured API keys for the models you want to use.

## Usage

### One-shot (blocks until done, 30s timeout)

```bash
pi-council ask "Should I refactor this module into microservices?"
```

### Background (returns immediately)

```bash
pi-council spawn "Analyze whether MSFT is oversold"
# do other work...
pi-council watch    # streams results as each agent finishes
pi-council status   # quick check on progress
pi-council results  # wait for all and print
pi-council cleanup  # kill + remove
```

### Select specific models

```bash
pi-council ask --models claude,grok "Review this PR for security issues"
```

### Custom timeout

```bash
pi-council ask --timeout 120 "Deep architecture review of this codebase"
```

### List all runs

```bash
pi-council list
```

## Default models

| ID | Provider | Model |
|----|----------|-------|
| claude | anthropic | claude-opus-4-6 |
| gpt | openai-codex | gpt-5.4 |
| gemini | google | gemini-3.1-pro-preview |
| grok | xai | grok-4.20-0309-reasoning |

Configure in `~/.pi-council/config.json`.

## How it works

- Each model runs as a **separate pi coding agent** with its own tools (bash, read)
- Agents do their own independent research — they are NOT given the same evidence
- Results are written to `~/.pi-council/runs/<run-id>/` as plain files any agent can read
- `ask` waits via `child.on('close')` — zero polling
- `watch` uses `fs.watch` — event-driven, prints each result the instant it lands
- 30s default timeout kicks out so the orchestrator can check for haywire agents

## Commands

| Command | Description |
|---------|-------------|
| `ask "question"` | One-shot: spawn, wait, print results |
| `spawn "question"` | Background: spawn and return run-id |
| `status [run-id]` | Show who's running, who's done |
| `results [run-id]` | Wait for completion and print outputs |
| `watch [run-id]` | Stream results as each agent finishes |
| `cleanup [run-id]` | Kill workers and remove run |
| `list` | Show all runs |

## For other agents

Any coding agent with shell access can use pi-council:

```bash
# Claude Code, Codex, Cursor, etc.
pi-council ask "your question"
```

Results are also readable from disk at `~/.pi-council/runs/<run-id>/results.json`.

## Zero dependencies

The runtime has zero npm dependencies. Just Node.js built-ins.

## License

MIT
