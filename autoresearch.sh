#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Build first
npm run build 2>&1

# Run benchmark suite
node tests/benchmark/run-benchmarks.mjs
