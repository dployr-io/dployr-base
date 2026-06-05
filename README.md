# dployr-base

The Base control plane. Handles authentication, cluster state, routing, and the WebSocket connections that `dployrd` instances maintain.

Built with [Hono](https://hono.dev), PostgreSQL, and Redis.

## Requirements

- Node.js 22+
- PostgreSQL
- Redis

## Dev

```bash
pnpm install
pnpm dev
```

Runs the app and API docs server concurrently. The app starts on the port configured in your environment.

## Tests

```bash
# Unit tests
pnpm test:unit

# Integration tests (spins up embedded Postgres + Redis)
pnpm test:api

# Both
pnpm test
```

## Build

```bash
pnpm build
```

Type-checks only (`tsc --noEmit`). The app runs directly via `tsx`.

---

Apache 2.0
