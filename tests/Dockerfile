FROM node:22-slim

# Create a non-root user for isolation
RUN useradd -m -s /bin/bash testuser

WORKDIR /app

# Copy package files and install deps (needed for extension tests)
COPY package.json ./
RUN npm install --ignore-scripts 2>/dev/null || true

# Copy build output and tests
COPY dist/ dist/
COPY tests/ tests/
COPY src/ src/

# Switch to non-root user — tests can't touch host filesystem
USER testuser

# Create isolated home directory
ENV HOME=/home/testuser

CMD ["node", "tests/council.test.mjs"]
