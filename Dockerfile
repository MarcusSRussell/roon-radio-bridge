FROM node:20-alpine

WORKDIR /app

# git is required because package.json pulls the Roon API modules from
# GitHub (github:roonlabs/node-roon-api etc.)
RUN apk add --no-cache git

# Install dependencies first for better layer caching
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy application code
COPY index.js roon.js routes.js logTail.js watchdog.js bridgeCommands.js config.js ./
COPY api/ ./api/

# The Roon API library writes its state (pairing tokens, extension
# settings) to config.json in the current working directory. We want
# that file persisted across container rebuilds, so we run from
# /app/config (which is mounted as a volume in docker-compose.yml)
# while the code itself stays at /app.
RUN mkdir -p /app/config
WORKDIR /app/config

EXPOSE 33262

CMD ["node", "/app/index.js"]
