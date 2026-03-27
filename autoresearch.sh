#!/bin/bash
set -e

# Build TypeScript
npx tsc 2>&1

# Build Docker sandbox image
docker build -t pi-council-test -f tests/Dockerfile . --quiet

# Run tests inside isolated Docker sandbox
# --network none: no API calls possible
# --tmpfs: writable home/tmp, nothing persists after exit
docker run --rm \
  --network none \
  --tmpfs /tmp:rw,nosuid \
  --tmpfs /home/testuser:rw,nosuid \
  pi-council-test
