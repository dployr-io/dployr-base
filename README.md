# Dployr Base

The management server for dployr. Run this on your infrastructure to control deployments, manage users, and handle billing.

---

## Installation

### Docker (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/dployr-io/dployr-base/main/docker-compose.example.yml -o docker-compose.yml

nano docker-compose.yml

docker compose up -d
```

Base will run on `http://localhost:7878` by default.  

### Shell installer

```bash
curl -fsSL https://raw.githubusercontent.com/dployr-io/dployr-base/main/install.sh | sudo bash

sudo systemctl start dployr-base
```

Or non-interactive:

```bash
curl -fsSL https://raw.githubusercontent.com/dployr-io/dployr-base/main/install.sh | sudo bash -s -- --non-interactive
```

---

## Traffic Router (Traefik)

Deploy the traffic routing layer to handle customer domains on `*.dployr.run`:

```bash
curl -fsSL https://raw.githubusercontent.com/dployr-io/dployr-base/main/scripts/traefik/install-traefik.sh | sudo bash
```

See [scripts/traefik/README.md](./scripts/traefik/README.md) for configuration, scaling, and troubleshooting.

---

## Configuration

Edit `config.toml` to set:

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

See `config.example.toml` for all available options.

---

## Development

```bash
npm run dev
```

---

## Documentation

- Self-hosting: https://docs.dployr.io/installation/self-hosting

License: Apache 2.0
