#!/bin/bash
# Mock pi binary for deterministic testing.
# Behavior controlled by MOCK_BEHAVIOR env var:
#   success    — emit valid JSONL with message_end stopReason=stop
#   error      — emit message_end with stopReason=error  
#   hang       — sleep forever (test timeout/cancel)
#   partial    — emit message_update only, no message_end
#   malformed  — mix valid and invalid JSON lines
#   large      — emit 1000+ events
#   crash      — emit partial output then exit 1
#   slow       — emit output with delays
#   empty      — exit 0 with no output

BEHAVIOR="${MOCK_BEHAVIOR:-success}"
DELAY="${MOCK_DELAY:-0}"

case "$BEHAVIOR" in
  success)
    [ "$DELAY" -gt 0 ] 2>/dev/null && sleep "$DELAY"
    echo '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Working on it..."}]}}'
    echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Mock answer from '"${MOCK_MODEL:-test}"'"}],"stopReason":"stop","usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.01}}}}'
    ;;
  error)
    echo '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"Mock API error"}}'
    exit 0
    ;;
  hang)
    echo '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Starting..."}]}}'
    sleep 3600
    ;;
  partial)
    echo '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Partial output only"}]}}'
    exit 0
    ;;
  malformed)
    echo '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Before bad line"}]}}'
    echo 'NOT VALID JSON {{{}'
    echo '{"truncated'
    echo ''
    echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"After bad lines"}],"stopReason":"stop","usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.001}}}}'
    ;;
  large)
    for i in $(seq 1 1000); do
      echo '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Event '"$i"'"}]}}'
    done
    echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall"}],"stopReason":"toolUse","usage":{"input":500,"output":200,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.05}}}}'
    echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Final answer after 1000 events"}],"stopReason":"stop","usage":{"input":600,"output":300,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.06}}}}'
    ;;
  crash)
    echo '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Started working..."}]}}'
    exit 1
    ;;
  slow)
    echo '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Thinking..."}]}}'
    sleep 1
    echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Slow but complete answer"}],"stopReason":"stop","usage":{"input":50,"output":25,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.005}}}}'
    ;;
  empty)
    exit 0
    ;;
  *)
    echo "Unknown MOCK_BEHAVIOR: $BEHAVIOR" >&2
    exit 1
    ;;
esac
