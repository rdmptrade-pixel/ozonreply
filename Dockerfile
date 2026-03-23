FROM node:20-alpine

# Install build tools needed for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install ALL dependencies (including dev) — needed for build AND native modules
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Expose port (Timeweb will set PORT env variable)
EXPOSE 3000

# Health check — wait up to 2 minutes for startup
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/api/stats || exit 1

# Start production server
CMD ["node", "dist/index.cjs"]
