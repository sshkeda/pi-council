#!/bin/bash
# Mock pi binary for integration tests.
# Writes a minimal JSONL stream to stdout simulating a pi agent response.
# Respects --mode json and outputs a message_end with stopReason=stop.

# Small delay to simulate real agent work
sleep 0.1

# Write a valid pi JSONL message_end event
cat <<'EOF'
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Mock response from test agent"}],"stopReason":"stop","usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.001}}}}
EOF
