FROM node:22-slim

# Create a non-root user for isolation
RUN useradd -m -s /bin/bash testuser

WORKDIR /app

# Copy package files first (layer caching for npm install)
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts --no-audit --no-fund 2>/dev/null || true

# Copy build output and test files
COPY dist/ dist/
COPY tests/ tests/

# Switch to non-root user — tests can't touch host filesystem
USER testuser

# Create isolated home directory
ENV HOME=/home/testuser

CMD ["node", "tests/council.test.mjs"]
