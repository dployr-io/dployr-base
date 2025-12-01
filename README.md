# Dployr Base

Control plane for Dployr.

Most people don’t need to run this themselves. You can use the hosted control plane for free:

- Base: https://base.dployr.dev
- API docs: https://api-docs.dployr.dev

Only keep reading if you want to self‑host your own Base server.

---

## Quick start (self‑hosting)

### Option 1: Docker (simple, recommended)

```bash
# Download example compose file
curl -fsSL https://raw.githubusercontent.com/dployr-io/dployr-base/main/docker-compose.example.yml -o docker-compose.yml

# Edit a few values (domains, OAuth keys, etc.)
nano docker-compose.yml

# Start
docker compose up -d
```

Base will be available on `http://localhost:3000` by default.  
See [DOCKER.md](./DOCKER.md) for more examples.

### Option 2: Shell installer (no Docker)

```bash
# Basic install
curl -fsSL https://raw.githubusercontent.com/dployr-io/dployr-base/main/install.sh | sudo bash

# Example with Upstash Redis
curl -fsSL https://raw.githubusercontent.com/dployr-io/dployr-base/main/install.sh \
  | sudo bash -s -- \
  --kv-type upstash \
  --kv-rest-url "https://your-db.upstash.io" \
  --kv-rest-token "your-token"

# Or from a config file
sudo bash install.sh --config /path/to/config.toml

# Start the service
sudo systemctl start dployr-base
```

### Option 3: Cloudflare Workers (same as production)

```bash
npm install
cp wrangler.example.toml wrangler.toml
# Edit wrangler.toml with your account ID
npm run deploy
```

---

## Config basics

Self‑hosted setups share the same `config.toml` layout:

```toml
[deployment]
platform = "self-hosted"  # or "cloudflare"

[database]
type = "sqlite"          # or "d1" for Cloudflare
path = "/var/lib/dployr-base/dployr.db"

[kv]
type = "redis"           # or "cloudflare", "upstash", "memory"
url = "redis://localhost:6379"

[storage]
type = "filesystem"      # or "r2", "s3", "azure"
path = "/var/lib/dployr-base/storage"
```

See `config.example.toml` for all fields.

---

## Development

```bash
# Local dev (uses config.toml)
npm run dev

# Cloudflare dev
npm run dev:cloudflare
```

---

## Links

- Self‑hosting guide: `docs/SELF_HOSTING.md`
- Config reference: `docs/CONFIG.md`
- API docs: https://api-docs.dployr.dev

License: Apache 2.0
