# Docker isolation for pi-council benchmarks
# Usage:
#   docker build -t pi-council-bench -f tests/benchmark/Dockerfile .
#   docker run --rm pi-council-bench

FROM node:22-slim

WORKDIR /app

# Copy project
COPY package*.json tsconfig.json ./
COPY src/ src/
COPY bin/ bin/

# Install deps and build
RUN npm install --ignore-scripts && npm run build

# Copy test files
COPY tests/benchmark/ tests/benchmark/

# Make mock-pi executable
RUN chmod +x tests/benchmark/mock-pi

# Run benchmarks
CMD ["node", "tests/benchmark/run-benchmarks.mjs"]
