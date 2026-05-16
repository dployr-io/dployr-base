#!/bin/bash

# Copyright 2025 Emmanuel Madehin
# SPDX-License-Identifier: Apache-2.0

set -eu

TRAEFIK_VERSION="${TRAEFIK_VERSION:-3.3.4}"
TOMATO_VERSION="${TOMATO_VERSION:-1.0.0}"
REPO="dployr-io/dployr-base"
BRANCH="${BRANCH:-main}"

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
  local tmp; tmp="$(mktemp -d)" || error "Failed to create temp directory"
  curl -fsSL "$url" -o "$tmp/tomato.tar.gz" || { rm -rf "$tmp"; error "Failed to download tomato"; }
  tar -xzf "$tmp/tomato.tar.gz" -C "$tmp" || { rm -rf "$tmp"; error "Failed to extract tomato"; }
  mv "$tmp/target/release/tomato" /usr/local/bin/tomato || { rm -rf "$tmp"; error "Failed to install tomato binary"; }
  chmod +x /usr/local/bin/tomato
  rm -rf "$tmp"
}

tget() { tomato get "$1" "$CONFIG_PATH" 2>/dev/null || echo ""; }
tset() { tomato set "$1" "$2" "$CONFIG_PATH" >/dev/null 2>&1; }

prompt() {
  local key="$1" label="$2" secret="${3:-false}"
  local current; current="$(tget "$key")"

  $SKIP_PROMPTS && return

  if [ -n "$current" ]; then
    local display="$current"
    $secret && display="[set]"
    printf "%s [%s] Keep this value? (y/n): " "$label" "$display"
    local choice
    read -r choice
    case "$choice" in
      ""|"y"|"Y") return 0 ;;
      "n"|"N") ;;
      *) tset "$key" "$choice"; return 0 ;;
    esac
  fi

  printf "%s: " "$label"
  local val
  read -r val
  [ -n "$val" ] && tset "$key" "$val"
  return 0
}

configure() {
  info "Configuring..."

  prompt "instance.name"      "Instance name (e.g. us-east, eu-south)"
  prompt "domains.tld"        "Customer domain (e.g. dployr.run)"
  prompt "redis.host"         "Redis host"
  prompt "redis.port"         "Redis port"
  prompt "redis.username"     "Redis username (optional)"
  prompt "redis.password"     "Redis password"           true
  prompt "redis.root_key"     "Redis root key/prefix"
  prompt "redis.tls"          "Redis TLS (true/false)"
  prompt "tls.acme_email"     "ACME email"
  prompt "tls.cf_api_token"   "Cloudflare API token"     true
  prompt "dashboard.username"    "Dashboard username"
  prompt "dashboard.allowed_ips" "Allowed IPs for dashboard (TOML array, e.g. [\"1.2.3.4\"])"
  prompt "logging.betterstack_endpoint" "Better Stack ingestion endpoint (leave blank to skip)"
  prompt "logging.betterstack_token"    "Better Stack source token"                              true

  local current_pass; current_pass="$(tget 'dashboard.password_hash')"
  if ! $SKIP_PROMPTS; then
    if [ -n "$current_pass" ]; then
      printf "Dashboard password [set] Keep this value? (y/n): "
      local choice
      read -r choice
      case "$choice" in
        ""|"y"|"Y") ;;
        "n"|"N")
          local pass
          printf "Dashboard password: "
          read -r pass
          [ -n "$pass" ] && tset "dashboard.password_hash" "$(htpasswd -nbB admin "$pass" | cut -d: -f2)"
          ;;
        *) tset "dashboard.password_hash" "$(htpasswd -nbB admin "$choice" | cut -d: -f2)" ;;
      esac
    else
      local pass
      printf "Dashboard password: "
      read -r pass
      [ -n "$pass" ] && tset "dashboard.password_hash" "$(htpasswd -nbB admin "$pass" | cut -d: -f2)"
    fi
  fi
}

generate_traefik_yml() {
  local instance; instance="$(tget 'instance.name')"
  local tld; tld="$(tget 'domains.tld')"
  local redis_host; redis_host="$(tget 'redis.host')"
  local redis_port; redis_port="$(tget 'redis.port')"
  local redis_user; redis_user="$(tget 'redis.username')"
  local redis_pass; redis_pass="$(tget 'redis.password')"
  local redis_tls; redis_tls="$(tget 'redis.tls')"
  local redis_key; redis_key="$(tget 'redis.root_key')"
  local email; email="$(tget 'tls.acme_email')"

  [ -z "$redis_key" ] && redis_key="traefik"

  local username_block=""
  [ -n "$redis_user" ] && username_block="    username: \"${redis_user}\""

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
          - main: "${tld}"
            sans:
              - "*.${tld}"

providers:
  redis:
    endpoints:
      - "${redis_host}:${redis_port}"
${username_block}
    password: "${redis_pass}"
${tls_block}
    rootKey: "${redis_key}"
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

metrics:
  prometheus: {}

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
  # strip any leading "user:" prefix if the hash was stored with it
  hash="${hash#*:}"
  local dashboard_domain="traefik-${instance}.${tld}"

  local allowed_ips_raw; allowed_ips_raw="$(tget 'dashboard.allowed_ips')"
  local allowed_ips=()
  if [ -n "$allowed_ips_raw" ]; then
    while IFS= read -r ip; do
      ip="$(echo "$ip" | tr -d ' "')"
      [ -n "$ip" ] && allowed_ips+=("$ip")
    done < <(echo "$allowed_ips_raw" | tr -d '[]' | tr ',' '\n')
  fi

  local ip_middleware_ref=""
  local ip_middleware_block=""
  if [ ${#allowed_ips[@]} -gt 0 ]; then
    local source_ranges=""
    for ip in "${allowed_ips[@]}"; do
      source_ranges+="          - \"${ip}\""$'\n'
    done
    ip_middleware_ref="        - dashboard-ip"$'\n'
    ip_middleware_block="    dashboard-ip:
      ipAllowList:
        sourceRange:
${source_ranges}"
  fi

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
${ip_middleware_ref}        - dashboard-auth
      tls: {}

  middlewares:
${ip_middleware_block}    dashboard-auth:
      basicAuth:
        users:
          - '${user}:${hash}'
EOF
}

install_traefik() {
  info "Downloading Traefik v${TRAEFIK_VERSION}..."
  local url="https://github.com/traefik/traefik/releases/download/v${TRAEFIK_VERSION}/traefik_v${TRAEFIK_VERSION}_linux_amd64.tar.gz"
  local tmp; tmp="$(mktemp -d)" || error "Failed to create temp directory"
  curl -fsSL "$url" -o "$tmp/traefik.tar.gz" || { rm -rf "$tmp"; error "Failed to download Traefik"; }
  tar -xzf "$tmp/traefik.tar.gz" -C "$tmp" || { rm -rf "$tmp"; error "Failed to extract Traefik"; }
  mv "$tmp/traefik" /usr/local/bin/traefik || { rm -rf "$tmp"; error "Failed to install Traefik binary"; }
  chmod +x /usr/local/bin/traefik
  rm -rf "$tmp"
}

install_vector() {
  if ! command -v vector >/dev/null 2>&1; then
    info "Installing Vector..."
    curl -1sLf 'https://setup.vector.dev' | bash >/dev/null 2>&1
    apt-get install -y vector >/dev/null 2>&1
  else
    info "Vector already installed: $(vector --version 2>&1 | head -1)"
  fi
  rm -f /etc/vector/vector.yaml
  rm -rf /etc/vector/examples
}

setup_vector() {
  local endpoint; endpoint="$(tget 'logging.betterstack_endpoint')"
  local token;    token="$(tget 'logging.betterstack_token')"

  [ -z "$endpoint" ] || [ -z "$token" ] && return

  install_vector

  mkdir -p /etc/vector

  cat > /etc/vector/vector.toml <<EOF
[sources.traefik]
type = "file"
include = ["/var/log/traefik/*.log"]

[sinks.better_stack]
type = "http"
inputs = ["traefik"]
uri = "${endpoint}"
encoding.codec = "json"

[sinks.better_stack.auth]
strategy = "bearer"
token = "${token}"
EOF

  mkdir -p /etc/systemd/system/vector.service.d
  cat > /etc/systemd/system/vector.service.d/override.conf <<EOF
[Service]
ExecStartPre=
ExecStart=
ExecStartPre=/usr/bin/vector validate /etc/vector/vector.toml
ExecStart=/usr/bin/vector --config-dir /etc/vector
EOF

  usermod -aG "$SERVICE_USER" vector >/dev/null 2>&1 || true
  chmod g+rX "$LOG_DIR" >/dev/null 2>&1 || true

  systemctl daemon-reload
  systemctl enable vector >/dev/null 2>&1
  systemctl restart vector
  info "Vector configured → Better Stack"
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
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

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
    local gh_args=(-fsSL)
    [ -n "${GITHUB_TOKEN:-}" ] && gh_args+=(-H "Authorization: Bearer $GITHUB_TOKEN")
    curl "${gh_args[@]}" -H "Accept: application/vnd.github.raw" \
        "https://api.github.com/repos/${REPO}/contents/scripts/traefik/config.example.toml?ref=${BRANCH}" -o "$CONFIG_PATH" \
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
  setup_vector

  sleep 2

  local instance; instance="$(tget 'instance.name')"
  local tld; tld="$(tget 'domains.tld')"
  local this_ip; this_ip="$(curl -fsSL --max-time 3 ifconfig.me 2>/dev/null || echo '<this-server-ip>')"

  if systemctl is-active --quiet traefik; then
    info "Traefik is running"
  else
    warn "Traefik failed to start — check: journalctl -u traefik -n 50"
  fi

  echo ""
  echo "Installation complete"
  echo ""
  echo "  Dashboard : https://traefik-${instance}.${tld}/dashboard/"
  echo "  Config    : ${CONFIG_PATH}"
  echo "  Logs      : journalctl -u traefik -f"
  echo ""
  echo "DNS records required (Cloudflare):"
  echo "  A  *.${tld}                             → ${this_ip}  (proxied ON)"
  echo "  A  traefik-${instance}.${tld}           → ${this_ip}  (proxied OFF)"
  echo ""
  echo "To reconfigure: sudo bash $0"
}

main
