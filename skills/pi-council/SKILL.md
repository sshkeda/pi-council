---
name: pi-council
description: >
  Spawn multiple AI models (Claude, GPT, Gemini, Grok) as independent pi agents
  to get parallel opinions on any question. Use when you need diverse model perspectives
  on architecture decisions, investment analysis, code review, or any high-stakes question.
---

# pi-council

Spawns different AI models in parallel. Each model is its own pi coding agent with
tools (bash, read). They work independently and write results to disk.

## Quick usage (blocking)
```bash
pi-council ask "Should I refactor this module into microservices?"
```

## Background usage
```bash
pi-council spawn "Analyze whether MSFT is oversold"
pi-council status          # check progress
pi-council results         # wait and print all outputs
pi-council cleanup         # kill + remove
```

## Select specific models
```bash
pi-council ask --models claude,grok "Review this PR for security issues"
```

## List all runs
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
