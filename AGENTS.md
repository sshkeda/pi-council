# pi-council

Multi-model council tool. Spawns different AI models in parallel for independent opinions.

## Usage

```bash
pi-council ask "your question"
pi-council spawn "your question"
pi-council watch
pi-council status
pi-council cleanup
pi-council list
```

## Select models

```bash
pi-council ask --models claude,gpt "your question"
```

Available models: `claude`, `gpt`, `gemini`, `grok`

## Results

Artifacts at `~/.pi-council/runs/<run-id>/`:
- `results.json` — structured
- `results.md` — human-readable

## Key design

- Each model is a separate agent with its own tools
- Models do their own independent research
- The point is surfacing **disagreement**, not consensus
