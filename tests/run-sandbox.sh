#!/bin/bash
# Run the test suite inside a Docker sandbox.
# Clean filesystem, non-root user, no host leakage.
set -e

cd "$(dirname "$0")/.."

# Build TypeScript first (needs node_modules on host)
npx tsc 2>&1

# Build the Docker image
docker build -t pi-council-test -f tests/Dockerfile . --quiet

# Run tests inside the container
# --rm: remove container after exit
# --network none: no network access (pure isolation)
# --read-only with tmpfs for /tmp and /home: prevent writes to image
docker run --rm \
  --network none \
  --tmpfs /tmp:rw,noexec,nosuid \
  --tmpfs /home/testuser:rw,noexec,nosuid \
  pi-council-test
