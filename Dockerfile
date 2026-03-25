FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

RUN mkdir -p /root/.cloud-certs && \
    cp /app/ca.crt /root/.cloud-certs/root.crt

ENV PGSSLROOTCERT=/root/.cloud-certs/root.crt

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/api/stats || exit 1

CMD ["node", "dist/index.cjs"]
