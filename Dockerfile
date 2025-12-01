FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
COPY pnpm-lock.yaml ./

RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm dlx esbuild src/index.unified.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --tsconfig=tsconfig.json \
  --outdir=dist \
  --external:@hono/node-server \
  --external:smol-toml \
  --external:redis \
  --external:@upstash/redis \
  --external:@aws-sdk/client-s3 \
  --external:better-sqlite3

FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
COPY pnpm-lock.yaml ./

RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile --prod && \
    pnpm add --prod \
      @hono/node-server \
      smol-toml \
      redis \
      @upstash/redis \
      @aws-sdk/client-s3 \
      better-sqlite3 && \
    pnpm rebuild better-sqlite3

COPY --from=builder /app/dist ./dist

RUN mkdir -p /data/storage

RUN addgroup -g 1001 -S dployr && \
    adduser -S dployr -u 1001 && \
    chown -R dployr:dployr /app /data

USER dployr

EXPOSE 7878

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:7878/v1/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "dist/index.unified.js"]
