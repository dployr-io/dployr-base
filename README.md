# Dployr Base

This is the control plane for [dployr](https://github.com/dployr-io/dployr).

Self-host your control plane for restricted networks or custom requirements.

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
curl -fsSL https://raw.githubusercontent.com/dployr-io/dployr-base/refs/heads/main/install.sh \
  | sudo bash -s --

# Example with Upstash Redis
curl -fsSL https://raw.githubusercontent.com/dployr-io/dployr-base/refs/heads/main/install.sh \
  | sudo bash -s -- \
  --kv-type upstash \
  --kv-rest-url "https://your-db.upstash.io" \
  --kv-rest-token "your-token"

# Or from a config file (remote script)
curl -fsSL https://raw.githubusercontent.com/dployr-io/dployr-base/refs/heads/main/install.sh \
  | sudo bash -s -- --config /path/to/config.toml

# Start the service
sudo systemctl start dployr-base
```

---

## Config basics

Self‑hosted setups share the same `config.toml` layout:

```toml
[database]
url = "postgresql://user:password@localhost:5432/dployr"

[kv]
type = "redis"
url = "redis://localhost:6379"

[storage]
type = "filesystem"
path = "/var/lib/dployr-base/storage"
```

See `config.example.toml` for all fields.

---

## Development

```bash
npm run dev
```

---

## Links

- Self‑hosting guide: https://docs.dployr.io/installation/self-hosting

License: Apache 2.0
