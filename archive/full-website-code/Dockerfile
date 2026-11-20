# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# TableNest — production image
# Works for Firebase App Hosting, Cloud Run, Render, Railway, VPS.
# ─────────────────────────────────────────────────────────────

FROM node:24-slim

# curl is used by the platform health checks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so the layer is cached between code changes.
COPY package*.json ./
RUN npm ci --omit=dev --no-fund --no-audit

# Application code.
COPY . .

# The platform injects PORT. Fall back to 3000 for local runs.
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--enable-source-maps

EXPOSE 3000

# /api/health is the endpoint the platform pings.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:${PORT}/api/health || exit 1

# Run as a non-root user (App Hosting / Cloud Run run as non-root anyway).
USER node

CMD ["node", "server.js"]
