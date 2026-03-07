# Build stage
FROM node:20-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Build TypeScript
RUN pnpm build

# Production stage
FROM node:20-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only
RUN pnpm install --prod

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Copy static developer portal
COPY public ./public

# App Runner routes external HTTPS → container port 8080 by default.
# Override at the service level via the PORT env var if needed.
EXPOSE 8080

# Start application
CMD ["node", "dist/index.js"]
