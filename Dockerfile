# ── Stage 1: install deps ──────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: lean runtime image ───────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./

# HTML pages served as static files
COPY --chown=node:node index.html  ./public/index.html
COPY --chown=node:node admin.html  ./public/admin.html
COPY --chown=node:node house.html  ./public/house.html

# config.json will be written here at runtime; mount a volume to persist it
RUN mkdir -p /data && chown node:node /data
ENV CONFIG_PATH=/data/config.json

# Run as unprivileged user
USER node

EXPOSE 3001

CMD ["node", "server.js"]
