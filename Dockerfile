FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./
COPY pnpm-lock.yaml ./

# Install pnpm and dependencies
RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build
RUN pnpm run build

# Production image
FROM node:22-alpine

WORKDIR /app

# Install runtime dependencies only
RUN apk add --no-cache python3 make g++

COPY package*.json ./
COPY pnpm-lock.yaml ./

RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile --prod

# Copy built app
COPY --from=builder /app/dist ./dist

# Create data directory
RUN mkdir -p /data/storage

# Run as non-root
RUN addgroup -g 1001 -S dployr && \
    adduser -S dployr -u 1001 && \
    chown -R dployr:dployr /app /data

USER dployr

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/v1/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "dist/index.unified.js"]
