#!/bin/bash

# Copyright 2025 Emmanuel Madehin
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

TRAEFIK_VERSION="${TRAEFIK_VERSION:-3.3.4}"
TOMATO_VERSION="${TOMATO_VERSION:-1.0.0}"
REPO="dployr-io/dployr-base"
BRANCH="${BRANCH:-main}"
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

CONFIG_DIR="/etc/traefik"
DATA_DIR="/var/lib/traefik"
LOG_DIR="/var/log/traefik"
CONFIG_PATH="$CONFIG_DIR/config.toml"
SERVICE_USER="traefik"

SKIP_PROMPTS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --non-interactive|-y) SKIP_PROMPTS=true; shift ;;
    --version) TRAEFIK_VERSION="$2"; shift 2 ;;
    *) shift ;;
  esac
done

[ ! -t 0 ] && SKIP_PROMPTS=true

info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*"; }
error() { echo "[ERROR] $*"; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || error "$1 is required but not installed"; }

install_tomato() {
  if command -v tomato >/dev/null 2>&1; then return; fi
  info "Installing tomato v${TOMATO_VERSION}..."
  local url="https://github.com/ceejbot/tomato/releases/download/v${TOMATO_VERSION}/tomato-x86_64-unknown-linux-gnu.tar.gz"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "$url" -o "$tmp/tomato.tar.gz" || error "Failed to download tomato"
  tar -xzf "$tmp/tomato.tar.gz" -C "$tmp"
  mv "$tmp/tomato" /usr/local/bin/tomato
  chmod +x /usr/local/bin/tomato
  rm -rf "$tmp"
}

tget() { tomato get "$CONFIG_PATH" "$1" 2>/dev/null || echo ""; }
tset() { tomato set "$CONFIG_PATH" "$1" "$2" >/dev/null; }

prompt() {
  local key="$1" label="$2" secret="${3:-false}"
  local current; current="$(tget "$key")"

  $SKIP_PROMPTS && return

  local display="$current"
  $secret && [ -n "$current" ] && display="[set]"
  [ -n "$display" ] && printf "%s [%s]: " "$label" "$display" || printf "%s: " "$label"

  local val
  if $secret; then read -rs val; echo; else read -r val; fi
  val="${val:-$current}"
  [ -n "$val" ] && tset "$key" "$val"
}

configure() {
  info "Configuring..."

  prompt "instance.name"      "Instance name (e.g. nyc1, ams1)"
  prompt "domains.customer"   "Customer domain"
  prompt "domains.infra"      "Infrastructure domain"
  prompt "redis.host"         "Redis host"
  prompt "redis.port"         "Redis port"
  prompt "redis.password"     "Redis password"           true
  prompt "redis.tls"          "Redis TLS (true/false)"
  prompt "tls.acme_email"     "ACME email"
  prompt "tls.cf_api_token"   "Cloudflare API token"     true
  prompt "dashboard.username" "Dashboard username"

  if $SKIP_PROMPTS || [ -n "$(tget 'dashboard.password_hash')" ]; then return; fi

  local pass
  printf "Dashboard password: "
  read -rs pass; echo
  [ -n "$pass" ] && tset "dashboard.password_hash" "$(openssl passwd -apr1 "$pass")"
}

generate_traefik_yml() {
  local instance; instance="$(tget 'instance.name')"
  local customer; customer="$(tget 'domains.customer')"
  local infra; infra="$(tget 'domains.infra')"
  local redis_host; redis_host="$(tget 'redis.host')"
  local redis_port; redis_port="$(tget 'redis.port')"
  local redis_pass; redis_pass="$(tget 'redis.password')"
  local redis_tls; redis_tls="$(tget 'redis.tls')"
  local redis_key; redis_key="$(tget 'redis.root_key')"
  local poll; poll="$(tget 'redis.poll_interval')"
  local email; email="$(tget 'tls.acme_email')"

  local tls_block=""
  [ "$redis_tls" = "true" ] && tls_block="    tls: {}"

  cat > "$CONFIG_DIR/traefik.yml" <<EOF
global:
  checkNewVersion: false
  sendAnonymousUsage: false

entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
          permanent: true
  websecure:
    address: ":443"
    http:
      tls:
        certResolver: cloudflare
        domains:
          - main: "${customer}"
            sans:
              - "*.${customer}"

providers:
  redis:
    endpoints:
      - "${redis_host}:${redis_port}"
    password: "${redis_pass}"
${tls_block}
    rootKey: "${redis_key}"
    pollInterval: "${poll}s"
  file:
    directory: "${CONFIG_DIR}/dynamic"
    watch: true

certificatesResolvers:
  cloudflare:
    acme:
      email: "${email}"
      storage: "${DATA_DIR}/acme.json"
      dnsChallenge:
        provider: cloudflare
        resolvers:
          - "1.1.1.1:53"
          - "8.8.8.8:53"

api:
  dashboard: true
  insecure: false

ping: {}

log:
  level: INFO
  filePath: "${LOG_DIR}/traefik.log"

accessLog:
  filePath: "${LOG_DIR}/access.log"
  bufferingSize: 100
  fields:
    headers:
      defaultMode: drop
      names:
        User-Agent: keep
        X-Forwarded-For: keep
EOF

  local user; user="$(tget 'dashboard.username')"
  local hash; hash="$(tget 'dashboard.password_hash')"
  local escaped_hash; escaped_hash="${hash//\$/\$\$}"
  local dashboard_domain="traefik-${instance}.${infra}"

  mkdir -p "$CONFIG_DIR/dynamic"
  cat > "$CONFIG_DIR/dynamic/dashboard.yml" <<EOF
http:
  routers:
    dashboard:
      rule: "Host(\`${dashboard_domain}\`)"
      service: api@internal
      entryPoints:
        - websecure
      middlewares:
        - dashboard-auth
      tls:
        certResolver: cloudflare
        domains:
          - main: "${dashboard_domain}"

  middlewares:
    dashboard-auth:
      basicAuth:
        users:
          - "${user}:${escaped_hash}"
EOF
}

install_traefik() {
  info "Downloading Traefik v${TRAEFIK_VERSION}..."
  local url="https://github.com/traefik/traefik/releases/download/v${TRAEFIK_VERSION}/traefik_v${TRAEFIK_VERSION}_linux_amd64.tar.gz"
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$url" -o "$tmp/traefik.tar.gz" || error "Failed to download Traefik"
  tar -xzf "$tmp/traefik.tar.gz" -C "$tmp"
  mv "$tmp/traefik" /usr/local/bin/traefik
  chmod +x /usr/local/bin/traefik
  setcap 'cap_net_bind_service=+ep' /usr/local/bin/traefik
}

setup_service() {
  local cf_token; cf_token="$(tget 'tls.cf_api_token')"
  [ -z "$cf_token" ] && warn "Cloudflare API token not set — TLS issuance will fail"

  cat > "$CONFIG_DIR/traefik.env" <<EOF
CF_DNS_API_TOKEN=${cf_token}
EOF
  chmod 600 "$CONFIG_DIR/traefik.env"

  cat > /etc/systemd/system/traefik.service <<EOF
[Unit]
Description=Dployr Traffic Router (Traefik)
After=network-online.target
Wants=network-online.target

[Service]
User=${SERVICE_USER}
Group=${SERVICE_USER}
EnvironmentFile=${CONFIG_DIR}/traefik.env
ExecStart=/usr/local/bin/traefik --configFile=${CONFIG_DIR}/traefik.yml
Restart=always
RestartSec=5
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${DATA_DIR} ${LOG_DIR}

[Install]
WantedBy=multi-user.target
EOF

  cat > /etc/logrotate.d/traefik <<EOF
${LOG_DIR}/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        systemctl kill --signal=USR1 traefik 2>/dev/null || true
    endscript
}
EOF

  systemctl daemon-reload
  systemctl enable traefik >/dev/null 2>&1 || true
  systemctl restart traefik 2>/dev/null || systemctl start traefik
}

main() {
  echo ""
  echo "Dployr Traffic Router Installer"
  echo ""

  [ "$EUID" -ne 0 ] && error "Run as root"
  require curl
  require openssl

  install_tomato

  id "$SERVICE_USER" &>/dev/null || useradd --system --no-create-home --shell /bin/false "$SERVICE_USER"
  mkdir -p "$CONFIG_DIR/dynamic" "$DATA_DIR" "$LOG_DIR"

  if [ ! -f "$CONFIG_PATH" ]; then
    info "Downloading config template..."
    curl -fsSL "${RAW}/scripts/traefik/config.example.toml" -o "$CONFIG_PATH" \
      || error "Failed to download config template"
    chmod 600 "$CONFIG_PATH"
  fi

  configure
  generate_traefik_yml

  touch "$DATA_DIR/acme.json"
  chmod 600 "$DATA_DIR/acme.json"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR"

  install_traefik
  setup_service

  sleep 2

  local instance; instance="$(tget 'instance.name')"
  local infra; infra="$(tget 'domains.infra')"
  local customer; customer="$(tget 'domains.customer')"
  local this_ip; this_ip="$(curl -fsSL --max-time 3 ifconfig.me 2>/dev/null || echo '<this-server-ip>')"

  if systemctl is-active --quiet traefik; then
    info "Traefik is running"
  else
    warn "Traefik failed to start — check: journalctl -u traefik -n 50"
  fi

  echo ""
  echo "Done"
  echo ""
  echo "  Dashboard : https://traefik-${instance}.${infra}/dashboard/"
  echo "  Config    : ${CONFIG_PATH}"
  echo "  Logs      : journalctl -u traefik -f"
  echo ""
  echo "DNS records required (Cloudflare):"
  echo "  A  *.${customer}                             → ${this_ip}  (proxied ON)"
  echo "  A  traefik-${instance}.${infra}              → ${this_ip}  (proxied OFF)"
  echo ""
  echo "To reconfigure: sudo bash $0"
}

main
