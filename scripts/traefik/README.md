## Architecture

```
*.dployr.run (Cloudflare DNS)
        │
        ▼
  Traffic Router (Traefik)
  ─ reads routes from Redis
  ─ issues wildcard TLS via Cloudflare DNS challenge
        │
        ▼
  Node VM (dployrd + Caddy)
  ─ Caddy routes to app port
        │
        ▼
  App process
```

---

## Domain Separation

- `dployr.run` → customer services (this layer)
- `dployr.io` → base server + dashboard access

---

## Scaling Model

- Each instance is **stateless**
- All instances connect to the **same Redis**
- Put a **load balancer in front**
- Dashboards are accessed **directly per instance (bypasses LB)**

---

## Prerequisites

- Ubuntu 24.04 LTS/ Debian 12 Bookworm (Debian preferred)
- Node.js (same as base)
- Root access
- Cloudflare managing:
    - `dployr.run`
    - `dployr.io`
- Cloudflare API token:
    - Permission → **Edit zone DNS**
- Redis instance (read-only credentials)

---

## Installation

### Standard install

```bash
git clone https://github.com/dployr-io/dployr-base
cd dployr-base
sudo bash scripts/install-traefik.sh
```

### Non-interactive (CI / provisioning)

```bash
sudo SKIP_PROMPTS=true \
  bash scripts/install-traefik.sh --non-interactive
```

### Regenerate Config

```bash
sudo node scripts/traefik/process-config.mjs \
  scripts/traefik/config.example.toml \
  /etc/traefik/config.toml \
  true

sudo systemctl restart traefik
```

---

## DNS Setup (Cloudflare)

| Type | Name | Value | Proxied |
| --- | --- | --- | --- |
| A | `*.dployr.run` | LB / Traefik IP | ON |
| A | `traefik-<region>.dployr.io` | Instance IP | OFF |

Notes:

- Each instance gets a **direct A record**
- Wildcard routes go through **load balancer**
- TLS is **automatic (no manual certs)**

---

## Dashboard

```
https://traefik-{instance-name}.dployr.io/dashboard/
```

- Protected via **basic auth**
- Must include trailing `/`

---

## Scaling Guide

### Add a Region

1. Provision server
2. Run installer (`instance.name = region`)
3. Point to same Redis
4. Add DNS record
5. Add to load balancer
6. Update wildcard DNS

---

### Load Balancer Options

- DigitalOcean LB → TCP 443 health check
- Cloudflare LB → `/ping` endpoint + geo routing

---

### Health Check

```
GET /ping (port 80)
```

Returns `200` when healthy.

---

## Troubleshooting

```bash
systemctl status traefik
journalctl -u traefik -f

curl -s http://localhost:8080/api/http/routers | jq '.[].rule'

openssl s_client -connect myservice.production.dployr.run:443 \
  | openssl x509 -noout -subject -issuer -dates

curl -H "Host: myservice.production.dployr.run" http://localhost/

redis-cli -h <host> -a <password> KEYS 'traefik/*'

systemctl kill --signal=SIGHUP traefik
```

---

## File Layout

```
/usr/local/bin/traefik

/etc/traefik/
  config.toml
  traefik.yml
  traefik.env
  dynamic/
    dashboard.yml

/var/lib/traefik/
  acme.json

/var/log/traefik/
  traefik.log
  access.log
```

---