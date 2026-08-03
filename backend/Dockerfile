# AutoPilot backend — multi-stage production image
#
# Layer strategy: dependency manifests are copied before source so a code-only
# change reuses the cached npm install layer.
#
# Base image note: `node:22-bookworm-slim` is right for Phase 1. In Phase 3,
# Playwright needs system Chromium libraries — at that point the runtime stage
# switches to `mcr.microsoft.com/playwright:v1.xx-jammy`, which ships them and the
# matching browser build. Do not hand-install libs onto slim; version skew between
# the Playwright package and the system browser is a recurring production failure.

# ── Stage 1: install all dependencies (including dev, needed to compile) ──────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV npm_config_update_notifier=false
COPY package.json package-lock.json* ./
# `npm ci` when a lockfile exists (reproducible); fall back to install otherwise.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ── Stage 2: generate the Prisma client and compile TypeScript ────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV npm_config_update_notifier=false
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
# Generate before compiling: the emitted types are what tsc type-checks against.
RUN npx prisma generate
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# ── Stage 3: production-only dependencies ─────────────────────────────────────
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
ENV npm_config_update_notifier=false
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

# ── Stage 4: runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# openssl is required by Prisma's query engine at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    npm_config_update_notifier=false

COPY --from=prod-deps /app/node_modules ./node_modules
# Overlay the generated Prisma client — `npm ci --omit=dev` installs the package
# but cannot generate it (no schema, no CLI at that point).
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
# Shipped so `prisma migrate deploy` can run as a release step in this image.
COPY prisma ./prisma
COPY package.json ./

# Run unprivileged. `node` (uid 1000) already exists in the base image.
RUN chown -R node:node /app
USER node

EXPOSE 8080

# Container-level liveness. Deliberately hits /health, not /health/ready: a slow
# database should not cause the orchestrator to kill a healthy process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Direct exec — no npm wrapper, so SIGTERM reaches Node and graceful shutdown
# actually runs. `--init` on the container provides PID 1 reaping.
CMD ["node", "--enable-source-maps", "dist/server.js"]
