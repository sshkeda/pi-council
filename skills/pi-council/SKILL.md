---
name: pi-council
description: >
  Spawn multiple AI models (Claude, GPT, Gemini, Grok) as independent pi agents
  to get parallel opinions on any question. Use when you need diverse model perspectives
  on architecture decisions, investment analysis, code review, or any high-stakes question.
version: 0.2.0
license: MIT
---

# pi-council

Spawns multi-model AI agents in parallel via RPC. Each model is its own pi coding agent with
tools and full bidirectional communication.

## Core principle: UNBIASED PROMPTING

When formulating a council question, you MUST strip your own conclusions, opinions, and biases.
The value of the council is in receiving genuinely independent perspectives. If you lead the
models toward your preferred answer, you defeat the purpose.

**DO:**
- Present the raw situation and constraints neutrally
- Include relevant context (code, data, requirements) without editorializing
- Ask open-ended questions: "What approach would you recommend?"

**DON'T:**
- Include your own analysis or preferred solution
- Frame the question to lead toward a specific answer
- Cherry-pick context that supports one conclusion

The differing opinions ARE the product. They give you signal you can't get from a single model.

## Pi extension (recommended)

If pi-council is installed as a pi package, you have these tools:

### spawn_council
Spawn a council. Returns immediately — results auto-delivered.

```
Use spawn_council to get opinions on whether to refactor this module
```

Parameters:
- `question` (required): The question for the council. Frame it neutrally.
- `models` (optional): Array of model IDs e.g. `["claude", "grok"]`. Default: all 4.
- `profile` (optional): Spawn profile — `"max"` (default), `"fast"`, `"read-only"`.

### council_followup
Send a follow-up to running council members.

Parameters:
- `message` (required): The follow-up message
- `type` (required): `"abort"` (interrupt immediately) or `"steer"` (queue after current tool call)
- `runId` (optional): Target specific council run
- `memberIds` (optional): Target specific members

### cancel_council
Cancel a running council or specific members.

### council_status
Get detailed status of all council members.

### read_stream
Read the accumulated output of a specific council member.

## CLI usage

```bash
pi-council ask "Should I refactor this module into microservices?"
pi-council spawn "Analyze whether MSFT is oversold"
pi-council status
pi-council watch
pi-council results
pi-council cleanup
pi-council list
```

### Select specific models
```bash
pi-council ask --models claude,grok "Review this PR for security issues"
```

## Results location
All run artifacts are stored in `~/.pi-council/runs/<run-id>/`:
- `meta.json` — run metadata
- `results.json` — structured results
- `results.md` — human-readable results

## Key design
- Each model is a separate pi instance with independent context via RPC
- Models do their own research — they are NOT given the same evidence
- The orchestrator can send follow-ups (steer/abort) to redirect members mid-flight
- The point is surfacing **disagreement**, not consensus
- The orchestrator (you) synthesizes the final answer from diverse perspectives
