# syntax=docker/dockerfile:1
# ADR-018: Google Cloud Run deployment
# Multi-stage build — final image contains only the standalone Next.js bundle.
#
# Build:  docker build -t video-sync .
# Run:    docker run -p 3080:3080 video-sync

# ── Stage 0: build WASM pkg from Rust source ────────────────────────────────
FROM rust:1.85-alpine AS wasm
RUN apk add --no-cache musl-dev curl && \
    curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY src/ ./src/
RUN wasm-pack build --target web --release --out-dir /build/pkg

# ── Stage 1: install dependencies ─────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev=false   # include devDeps for the build step

# ── Stage 2: build Next.js standalone bundle ──────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY web/ .
# WASM pkg built in stage 0 — import resolves ../../pkg from src/lib/ → /app/pkg/
COPY --from=wasm /build/pkg/ ./pkg/
RUN mkdir -p /app/public
RUN npm run build

# ── Stage 3: minimal runtime image ───────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3080
ENV HOSTNAME=0.0.0.0

# Non-root user for defence-in-depth
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs

# Standalone bundle
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Static assets (CSS, JS chunks, images)
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Public directory
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# data/ directory is mounted from GCS FUSE at runtime (ADR-018).
# Create it here so the app can write to it even without the mount (local dev).
RUN mkdir -p /app/data && chown nextjs:nodejs /app/data

USER nextjs

EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3080/api/backfill/state || exit 1

CMD ["node", "server.js"]
