# pi-council

Multi-model council tool. Spawns different AI models in parallel for independent opinions.

## Usage

```bash
pi-council ask "your question"
pi-council spawn "your question"
pi-council watch
pi-council cleanup
```

Select models: `pi-council ask --models claude,gpt "question"`

Results at `~/.pi-council/runs/<run-id>/results.json`
