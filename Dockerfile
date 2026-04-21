# OmniCrawl Docker Image
# Multi-stage build for minimal production image

# ── Build Stage ────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Copy dependency files first for layer caching
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci --ignore-scripts

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# ── Production Stage ────────────────────────────────────────────
FROM node:22-slim AS production

LABEL maintainer="Lan <Lyx3314844-03>"
LABEL description="OmniCrawl - multi-mode web crawling framework"
LABEL version="1.1.0"

# Install Chromium for Puppeteer browser mode
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use installed Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Copy dependency files
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts

# Copy source code from builder
COPY --from=builder /app/src/ ./src/
COPY LICENSE README.md ./

# Create non-root user for security
RUN groupadd -r omnicrawl && useradd -r -g omnicrawl -d /app omnicrawl
RUN mkdir -p /app/.omnicrawl && chown -R omnicrawl:omnicrawl /app
USER omnicrawl

# Default environment variables
ENV NODE_ENV=production

# Expose API server port
EXPOSE 3100

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3100/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Default entry point: start the API server
ENTRYPOINT ["node", "src/cli.js"]
CMD ["serve"]
