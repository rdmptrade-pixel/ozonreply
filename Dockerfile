FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --include=dev

# Copy source and build
COPY . .
RUN npm run build

# Remove dev dependencies after build
RUN npm ci --omit=dev

# Expose port (Timeweb will set PORT env variable)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/api/stats || exit 1

# Start production server
CMD ["node", "dist/index.cjs"]
