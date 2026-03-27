FROM node:22-slim

# Create a non-root user for isolation
RUN useradd -m -s /bin/bash testuser

WORKDIR /app

# Copy only what's needed for tests
COPY package.json tsconfig.json ./
COPY dist/ dist/
COPY tests/ tests/
COPY src/ src/

# Switch to non-root user — tests can't touch host filesystem
USER testuser

# Create isolated home directory
ENV HOME=/home/testuser

CMD ["node", "tests/council.test.mjs"]
