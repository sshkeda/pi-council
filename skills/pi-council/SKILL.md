---
name: pi-council
description: >
  Spawn multiple AI models (Claude, GPT, Gemini, Grok) as independent pi agents
  to get parallel opinions on any question. Use when you need diverse model perspectives
  on architecture decisions, investment analysis, code review, or any high-stakes question.
version: 0.1.0
license: MIT
---

# pi-council

Spawns different AI models in parallel. Each model is its own pi coding agent with
tools (bash, read). They work independently and write results to disk.

## Pi extension (recommended)

If pi-council is installed as a pi package, you have the `spawn_council` tool:

```
Use spawn_council to get opinions on whether to refactor this module
```

- Returns immediately — continue working
- Results auto-delivered when all agents finish
- Zero polling needed

### spawn_council parameters
- `question` (required): The question for the council
- `models` (optional): Array of model IDs e.g. `["claude", "grok"]`. Default: all 4.

## CLI usage

Also available as a CLI for any agent with bash access:

### One-shot (blocks until done, 30s timeout)
```bash
pi-council ask "Should I refactor this module into microservices?"
```

### Background
```bash
pi-council spawn "Analyze whether MSFT is oversold"
pi-council status          # check progress
pi-council watch           # stream results as each agent finishes
pi-council results         # wait and print all outputs
pi-council cleanup         # kill + remove
```

### Select specific models
```bash
pi-council ask --models claude,grok "Review this PR for security issues"
```

### List all runs
```bash
pi-council list
```

## Results location
All run artifacts are stored in `~/.pi-council/runs/<run-id>/`:
- `meta.json` — run metadata
- `<model>.jsonl` — raw pi event stream per model
- `results.json` — structured results
- `results.md` — human-readable results

## Key design
- Each model is a separate pi instance with independent context
- Models do their own research — they are NOT given the same evidence
- The point is surfacing **disagreement**, not consensus
- The orchestrator (you) makes the final decision
