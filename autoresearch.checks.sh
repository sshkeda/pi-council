#!/bin/bash
# Quick checks that must pass for any experiment to be kept
set -e

# Type check
npx tsc --noEmit 2>&1

echo "CHECKS PASSED"
