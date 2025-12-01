# Dployr Base

This is the control plane for [dployr](https://github.com/dployr-io/dployr).

Most users do not need to self-host. The free hosted control plane is globally available and delivered at low latency via Cloudflare’s edge network:

- Base: https://base.dployr.dev
- Dashboard: https://app.dployr.dev
- Documentation: https://docs.dployr.dev
- API Reference: https://api-docs.dployr.dev

Continue below only if you are in a restricted network or have very special requirements that require deploying and managing your own control plane & web dashboard.

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

Base will be available on `http://localhost:7878` by default.  
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

- Self‑hosting guide: https://docs.dployr.dev/installation/self-hosting

License: Apache 2.0
