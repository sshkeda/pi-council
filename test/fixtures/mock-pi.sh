#!/bin/bash
# Mock pi binary. Behavior controlled by MOCK_BEHAVIOR env var.
BEHAVIOR="${MOCK_BEHAVIOR:-success}"
case "$BEHAVIOR" in
  success)
    echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Mock answer from test agent"}],"stopReason":"stop","usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.01}}}}'
    ;;
  error)
    echo '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"Mock API error"}}'
    ;;
  hang)
    echo '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Starting..."}]}}'
    sleep 3600
    ;;
  crash)
    echo '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Started..."}]}}'
    exit 1
    ;;
  empty)
    exit 0
    ;;
  *)
    echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Mock answer"}],"stopReason":"stop"}}'
    ;;
esac
