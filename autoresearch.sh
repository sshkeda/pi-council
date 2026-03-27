#!/bin/bash
set -e

# Build
npx tsc 2>&1

# Run tests
node tests/council.test.mjs
