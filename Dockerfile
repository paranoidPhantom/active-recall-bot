FROM oven/bun:latest

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install

# Copy source code
COPY . .

# Initialize DB if not present (handled by app logic, but volume ensures persistence)
# Run the application
CMD ["bun", "run", "index.ts"]
