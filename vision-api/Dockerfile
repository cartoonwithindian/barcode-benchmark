# Multi-stage production Dockerfile for foodguard-vision-api (Fastify + Node 24)
#
# Design rationale (why these choices):
# - Node 24 slim on Debian Bookworm (glibc): aligns with Render's default linux/amd64 glibc runtime.
#   Alpine/musl is deliberately avoided because `sharp` ships glibc-based prebuilt libvips binaries
#   for linux-x64; using musl would require building libvips from source (heavy, slow, fragile) or
#   mismatched binaries. tesseract.js WASM and zxing/zbar WASM also run fine under glibc.
# - Multi-stage: `deps` installs production dependencies with lifecycle scripts allowed for native
#   packages (sharp, esbuild) as required by the repo's allowScripts; `build` compiles TypeScript
#   to `dist/`; `runtime` copies only what the server needs (dist, assets, node_modules prod, package.json).
# - Non-root execution, signal-aware CMD, and a `/health` HEALTHCHECK to match Render's probes.
# - Layer caching: `package*.json` copied first, then npm install, then source/tsconfigs/assets copied
#   before build so dependency layers cache independently of app code.

# --- Base image ---
ARG NODE_VERSION=24-slim
FROM node:${NODE_VERSION} AS base
ENV NODE_ENV=production \
  npm_config_fund=false \
  npm_config_audit=false \
  NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app

# --- Deps stage: install production dependencies with scripts enabled for native deps ---
FROM base AS deps
# Copy manifests first for better layer caching
COPY package.json package-lock.json ./
# npm 12 blocks lifecycle scripts by default; the repo allowlist permits scripts for sharp/esbuild/tesseract.js.
# Ensure those postinstall scripts (especially sharp's native build/prebuilt validation) run in the image.
RUN --mount=type=cache,target=/root/.npm \
  set -eux; \
  npm ci --omit=dev --ignore-scripts=false
# At this point node_modules contains production deps with required install scripts executed.

# --- Build stage: compile TypeScript to dist ---
FROM base AS build
# The base image sets NODE_ENV=production, which makes `npm ci` skip
# devDependencies — and typescript lives there. Flip it for the install+build,
# the runtime stage below switches back.
ENV NODE_ENV=development
# Install full deps (including dev) to compile with tsc/tsx deps available
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
  set -eux; \
  npm ci --include=dev --ignore-scripts=false
# Copy source and build config
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Build (tsc -p tsconfig.build.json)
RUN set -eux; \
  ./node_modules/typescript/bin/tsc -p tsconfig.build.json

# --- Runtime stage: minimal image running as non-root ---
FROM base AS runtime
# Create non-root user
RUN set -eux; \
  useradd -m -u 10001 -r nodeapp && \
  chown -R nodeapp:nodeapp /app
# Copy only runtime artifacts
COPY --from=deps --chown=nodeapp:nodeapp /app/node_modules ./node_modules
COPY --from=build --chown=nodeapp:nodeapp /app/dist ./dist
COPY --from=build --chown=nodeapp:nodeapp /app/package.json ./package.json
# Vendored runtime assets (must never be fetched from CDN at runtime)
COPY --chown=nodeapp:nodeapp assets ./assets
# Document port and OCI metadata
EXPOSE 8000
LABEL org.opencontainers.image.title="foodguard-vision-api" \
  org.opencontainers.image.description="Fastify barcode detection, OCR, ingredient extraction service" \
  org.opencontainers.image.source="https://github.com/barcode-benchmark/vision-api" \
  org.opencontainers.image.licenses="MIT"
# Runtime env. PORT is read from the environment at runtime (Render injects it
# and the server binds 0.0.0.0:$PORT); 8000 is only the local default.
ENV NODE_ENV=production \
  PORT=8000 \
  NODE_OPTIONS=--max-old-space-size=384
# Healthcheck probes /health (fast, no OCR warmup)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http=require('http');const p=process.env.PORT||8000;http.get('http://127.0.0.1:'+p+'/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"
USER nodeapp
# Graceful shutdown friendly; tini not needed in Node 24 slim but STOPSIGNAL is explicit
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
