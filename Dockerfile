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

# The Roon extension library stores its pairing token in ./config/roon-state
# within the working directory. Mount a volume at /app/config to persist.
RUN mkdir -p /app/config

EXPOSE 33262

CMD ["node", "index.js"]
