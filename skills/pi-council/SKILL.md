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

## Pi extension tools

### spawn_council
Spawn a council. Returns immediately — results auto-delivered as each member finishes.

Parameters:
- `question` (required): The question for the council. Frame it neutrally.
- `models` (optional): Array of model IDs e.g. `["claude", "grok"]`. Default: all 4.

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
Get detailed status of all council members — state, elapsed time, streaming status, stderr, output length.
**Only use when something seems stuck or the user explicitly asks.** Do NOT poll after spawning.

### read_stream
Read a member's full accumulated output, stderr, and debug info.
**Only use to re-read a past result or when the user asks.** Output is auto-delivered via followUp.

## Results location
All run artifacts at `~/.pi-council/runs/<run-id>/`:
- `meta.json` — run metadata (prompt, models, startedAt)
- `prompt.txt` — raw prompt text
- `<member>.json` — per-member result (written as each finishes)
- `results.json` — combined result (written when all done)
- `results.md` — human-readable combined result

## Key design
- Each model is a separate pi instance with independent context via RPC
- Models do their own research — they are NOT given the same evidence
- The orchestrator can send follow-ups (steer/abort) to redirect members mid-flight
- The point is surfacing **disagreement**, not consensus
- The orchestrator synthesizes the final answer from diverse perspectives
- Per-member results are written to disk immediately — they survive context compaction

## IMPORTANT: Do NOT poll after spawning
Results are auto-delivered as followUp messages — each member's output arrives as it finishes,
and a final summary arrives when all are done. After calling spawn_council, continue your other
work or wait for the followUps. Do NOT call council_status or read_stream in a polling loop.
Only use those tools if something seems stuck (>60s with no results) or the user explicitly asks.
