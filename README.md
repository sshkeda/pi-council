# pi-council — Multi-Model AI Council for Parallel Agent Opinions

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

> Spawn Claude, GPT, Gemini, and Grok as independent coding agents to get parallel opinions on architecture decisions, code review, investment analysis, and more. Powered by [pi](https://github.com/badlogic/pi-mono).

## Why

One model can be wrong. Different models are wrong about different things. The point isn't consensus — it's surfacing **disagreement** so you (or your orchestrator) can make a better decision.

## Use Cases

- **Architecture decisions** — get 4 independent opinions before committing to microservices vs monolith
- **Code review** — catch bugs one model misses by running all four in parallel
- **Investment analysis** — cross-validate trade ideas across Claude, GPT, Gemini, and Grok
- **Security audits** — surface vulnerabilities with diverse model perspectives
- **Technical design docs** — stress-test proposals with multi-model critique

## Install

Via pi (recommended):

```bash
pi install git+https://github.com/sshkeda/pi-council.git
```

Or link locally:

```bash
git clone https://github.com/sshkeda/pi-council.git
cd pi-council
npm install && npm run build && npm link
```

Requires [pi](https://github.com/badlogic/pi-mono) and configured API keys for the models you want to use.

## Pi Extension (recommended)

When installed as a pi package, pi-council registers a `spawn_council` tool that the LLM can call directly:

```
Use spawn_council to get opinions on this architecture decision
```

**How it works:**
1. LLM calls `spawn_council` → tool returns immediately
2. LLM continues foreground work (reading files, running tools, talking to you)
3. Background agents finish → results auto-delivered via `followUp`
4. LLM gets a new turn with all council results — zero polling

**Parameters:**
- `question` (required): The question for the council
- `models` (optional): Array of model IDs, e.g. `["claude", "grok"]`

## CLI Usage

Also works as a plain CLI — any agent with bash access can use it.

### One-shot (blocks until done)

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
pi-council cancel   # kill workers, keep files for inspection
pi-council cleanup  # kill workers and delete run
```

### Select specific models

```bash
pi-council ask --models claude,grok "Review this PR for security issues"
```

### List all runs

```bash
pi-council list
```

## Default Models

| ID | Provider | Model |
|----|----------|-------|
| claude | anthropic | claude-opus-4-6 |
| gpt | openai-codex | gpt-5.4 |
| gemini | google | gemini-3.1-pro-preview |
| grok | xai | grok-4.20-0309-reasoning |

Configure in `~/.pi-council/config.json` (auto-created on first run with defaults).

## How It Works

- Each model runs as a **separate pi coding agent** with its own tools (bash, read)
- Agents do their own independent research — they are NOT given the same evidence
- Results are written to `~/.pi-council/runs/<run-id>/` as plain files any agent can read
- **Pi extension**: returns immediately, auto-notifies via `followUp` when done
- **CLI `ask`**: waits via `child.on('close')` — zero polling
- **CLI `watch`**: uses `fs.watch` — event-driven, prints each result the instant it lands
- Default 600s timeout — agents are killed if they exceed it (configurable via `timeout_seconds` in config or `--timeout` flag)

## Pi Skill

pi-council includes a skill file at `skills/pi-council/SKILL.md` that teaches any pi agent how and when to use the tool. When installed as a pi package, the skill is auto-discovered — no manual setup needed.

## Two Interfaces, Same Artifacts

| Interface | For | How |
|-----------|-----|-----|
| **Pi extension** (`spawn_council` tool) | Agents running inside pi | Returns immediately, auto-delivers results |
| **CLI** (`pi-council` command) | Claude Code, Codex, Cursor, shell scripts | Shell out, read results from disk |

Both write to the same `~/.pi-council/runs/` directory.

## Commands

| Command | Description |
|---------|-------------|
| `ask "question"` | One-shot: spawn, wait, print results |
| `spawn "question"` | Background: spawn and return run-id |
| `status [run-id]` | Show who's running, who's done |
| `results [run-id]` | Wait for completion and print outputs |
| `watch [run-id]` | Stream results as each agent finishes |
| `cancel [run-id]` | Kill workers, keep files for inspection |
| `cleanup [run-id]` | Kill workers and delete run |
| `list` | Show all runs |

## Dependencies

The CLI has zero npm runtime dependencies — just Node.js built-ins. The pi extension uses pi's built-in packages as peer dependencies.

## License

MIT © [sshkeda](https://github.com/sshkeda)
