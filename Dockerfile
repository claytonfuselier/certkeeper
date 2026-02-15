# ============================================================
# Stage 1 — Install Node.js dependencies
# ============================================================
FROM node:24-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ============================================================
# Stage 2 — Final image with certbot + Node.js runtime
# ============================================================
FROM python:3.13-alpine

# Install certbot and the Cloudflare DNS plugin
RUN pip install --no-cache-dir certbot certbot-dns-cloudflare

# Install Node.js runtime and tini (PID 1 init)
RUN apk add --no-cache nodejs tini

WORKDIR /app

# Create persistent directories
RUN mkdir -p /app/data /app/logs /var/lib/letsencrypt

# Copy the node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY src ./src
COPY public ./public
COPY package.json ./

# Persistent volumes for certs, app data, and logs
VOLUME ["/etc/letsencrypt", "/app/data", "/app/logs"]

# Expose the HTTPS web UI port
EXPOSE 3000

# Use tini as PID 1 for proper signal handling
ENTRYPOINT ["tini", "--"]

CMD ["node", "src/index.js"]
