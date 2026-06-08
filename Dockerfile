# syntax=docker/dockerfile:1
# ADR-018: Google Cloud Run deployment
# Multi-stage build — final image contains only the standalone Next.js bundle.
#
# Build:  docker build -t video-sync .
# Run:    docker run -p 3080:3080 video-sync

# ── Stage 0: build WASM pkg from Rust source ────────────────────────────────
FROM rust:1.86-alpine AS wasm
# Pin wasm-bindgen-cli to the version matching our project's Cargo.lock
# (wasm-bindgen 0.2.108). --locked uses the CLI's own lockfile so its
# transitive deps stay compatible with this rustc — protects against
# upstream drift where a new CLI release pulls in a dep that demands
# a newer rustc (e.g. 2026-06-08 incident: 0.2.123 → time → rustc 1.88).
RUN apk add --no-cache musl-dev curl && \
    curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh && \
    cargo install wasm-bindgen-cli --version 0.2.108 --locked
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src/ ./src/
RUN wasm-pack build --target web --release --out-dir /build/pkg

# ── Stage 1: install dependencies ─────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev=false   # include devDeps for the build step

# ── Stage 2: build Next.js standalone bundle ──────────────────────────────────
FROM node:20-alpine AS builder
ARG BUILD_SHA=unknown
ARG BUILD_DATE
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY web/ .
# WASM pkg comes from stage 0 (wasm-pack build from the current Rust src/).
# web/src/lib/wasm.ts imports "../../pkg/video_sync", which from
# /app/src/lib resolves to /app/pkg — so the freshly-built pkg MUST land
# at ./pkg (i.e. /app/pkg). This COPY runs AFTER `COPY web/ .`, so it
# overwrites any stale web/pkg that rode along in the build context.
# (Previously this copied to ../pkg = /pkg, which the import never
# references, so the bundle silently used the stale context web/pkg —
# that's how a Kaltura-less WASM kept getting deployed.)
COPY --from=wasm /build/pkg ./pkg/
# Ensure public/ exists so the COPY in the runner stage doesn't fail
RUN mkdir -p /app/public
# Next 15 type-check worker OOMs at the default ~2GB heap once the project
# crossed ~30 routes; bumping --max-old-space-size keeps the worker alive.
RUN NEXT_PUBLIC_BUILD_SHA=${BUILD_SHA} NEXT_PUBLIC_BUILD_DATE=${BUILD_DATE} NODE_OPTIONS=--max-old-space-size=4096 npm run build

# ── Stage 3: minimal runtime image ───────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3080
ENV HOSTNAME=0.0.0.0

# Non-root user for defence-in-depth
# yt-dlp + ffmpeg required for YouTube source ingestion (ADR-027)
RUN apk add --no-cache ffmpeg yt-dlp

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
