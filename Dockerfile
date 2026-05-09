# Build stage — API (tsc) + developer portal (Vite → public/)
FROM node:20-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY portal/package.json portal/

RUN pnpm install

COPY tsconfig.json ./
COPY portal ./portal
COPY src ./src
COPY public ./public

# Injected at `docker build --build-arg BUILD_GIT_SHA=...` so responses expose a real deploy id.
ARG BUILD_GIT_SHA=
ENV VALUATION_MODEL_VERSION=${BUILD_GIT_SHA}

RUN pnpm run build

# Production stage
FROM node:20-slim

ENV NODE_ENV=production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY portal/package.json portal/

RUN pnpm install --prod

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

EXPOSE 8080

ENV KEY_ISSUANCE_ENABLED=1

CMD ["node", "dist/index.js"]
