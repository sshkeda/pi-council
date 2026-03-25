# pi-council

Multi-model council tool. Spawns different AI models in parallel for independent opinions.

## Usage (from bash)

```bash
# One-shot — blocks until all models respond
pi-council ask "Should I refactor this module?"

# Background — returns immediately
pi-council spawn "Analyze this architecture"
pi-council watch    # stream results as they finish
pi-council status   # quick check
pi-council cleanup  # kill + remove
```

## Select models

```bash
pi-council ask --models claude,grok "Review this PR"
```

## Results on disk

All artifacts at `~/.pi-council/runs/<run-id>/`:
- `results.json` — structured results
- `results.md` — human-readable
- `<model>.jsonl` — raw event streams

## Philosophy

The point is **disagreement**, not consensus. Different models are wrong about different things. Pay attention to the dissenter.
