#!/bin/bash

# Copyright 2025 Emmanuel Madehin
# SPDX-License-Identifier: Apache-2.0

set -eu

VERSION="${VERSION:-latest}"
TOMATO_VERSION="${TOMATO_VERSION:-1.0.0}"
INSTALL_DIR="${INSTALL_DIR:-/opt/dployr-base}"
CONFIG_DIR="/etc/dployr-base"
CONFIG_PATH="$CONFIG_DIR/config.toml"
SERVICE_USER="dployr"
REPO="dployr-io/dployr-base"
RAW="https://raw.githubusercontent.com/${REPO}"

SKIP_PROMPTS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --non-interactive|-y) SKIP_PROMPTS=true; shift ;;
    -v|--version) VERSION="$2"; shift 2 ;;
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
    [ "$choice" = "n" ] || return 0
  fi

  printf "%s: " "$label"
  local val
  if $secret; then read -rs val; echo; else read -r val; fi
  [ -n "$val" ] && tset "$key" "$val"
}

configure() {
  info "Configuring..."

  prompt "server.base_url"               "Base URL (e.g. https://base.dployr.io)"
  prompt "server.app_url"                "App URL (e.g. https://app.dployr.io)"
  prompt "server.port"                   "Server port"

  prompt "database.url"                  "PostgreSQL connection string"             true

  prompt "kv.url"                        "Redis URL (e.g. redis://host:6379)"       true

  prompt "storage.type"                  "Storage type (filesystem/s3)"
  prompt "storage.path"                  "Storage path (if filesystem)"

  prompt "auth.github_client_id"         "GitHub OAuth client ID"
  prompt "auth.github_client_secret"     "GitHub OAuth client secret"               true
  prompt "auth.google_client_id"         "Google OAuth client ID"
  prompt "auth.google_client_secret"     "Google OAuth client secret"               true

  prompt "admin.admin_api_key"           "Admin API key"                            true
  prompt "admin.totp_secret"             "Admin TOTP secret"                        true
  prompt "admin.allowed_ips"             "Allowed admin IPs (TOML array)"

  prompt "integrations.github_token"     "GitHub personal access token"             true

  prompt "email.provider"                "Email provider"
  prompt "email.from_address"            "From address"
  prompt "email.zepto_api_key"           "Zepto API key"                            true

  prompt "security.encryption_key"       "Encryption key (AES-256, hex 32 bytes)"   true
  prompt "security.session_ttl"          "Session TTL (seconds)"

  prompt "cors.allowed_origins"          "CORS allowed origins"

  prompt "billing.polar_access_token"    "Polar access token"                       true
  prompt "billing.polar_webhook_secret"  "Polar webhook secret"                     true
  prompt "billing.polar_environment"     "Polar environment (sandbox/production)"

  prompt "virtual_machines.provider"     "VM provider (digitalocean)"
  prompt "virtual_machines.do_api_token" "DigitalOcean API token"                   true
  prompt "virtual_machines.ssh_key"      "DigitalOcean SSH key ID"
}

main() {
  echo ""
  echo "Dployr Base Installer"
  echo ""

  [ "$EUID" -ne 0 ] && error "Run as root"
  [ ! -t 0 ] && ! $SKIP_PROMPTS && error "Interactive mode requires a terminal. Use --non-interactive."
  require curl
  require node

  install_tomato

  if [ "$VERSION" = "latest" ]; then
    VERSION="$(curl -fsSL https://api.github.com/repos/${REPO}/releases/latest \
      | grep -m1 '"tag_name"' \
      | sed 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/')"
    [ -z "$VERSION" ] && error "Failed to resolve latest version"
  fi

  info "Version: $VERSION"
  info "Installing to $INSTALL_DIR"

  id "$SERVICE_USER" &>/dev/null || useradd --system --no-create-home --shell /bin/false "$SERVICE_USER"
  mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" /var/log/dployr-base /var/lib/dployr-base/storage

  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/dployr-base-${VERSION}.tar.gz"
  curl -fsSL "$DOWNLOAD_URL" | tar -xz -C "$INSTALL_DIR"

  info "Installing dependencies..."
  cd "$INSTALL_DIR"
  npm install --omit=dev

  if [ ! -f "$CONFIG_PATH" ]; then
    info "Downloading config template..."
    curl -fsSL "${RAW}/${VERSION}/config.example.toml" -o "$CONFIG_PATH" \
      || curl -fsSL "${RAW}/main/config.example.toml" -o "$CONFIG_PATH" \
      || error "Failed to download config template"
  fi

  configure

  info "Creating systemd service..."

  cat > /etc/systemd/system/dployr-base.service <<EOF
[Unit]
Description=Dployr Base
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
Environment="NODE_ENV=production"
Environment="CONFIG_PATH=$CONFIG_DIR/config.toml"
Environment="BASE_VERSION=$VERSION"
ExecStart=/usr/bin/node --import tsx $INSTALL_DIR/src/index.ts
Restart=always
RestartSec=10
StandardOutput=append:/var/log/dployr-base/output.log
StandardError=append:/var/log/dployr-base/output.log

[Install]
WantedBy=multi-user.target
EOF

  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR" "$CONFIG_DIR" /var/log/dployr-base /var/lib/dployr-base
  chmod 600 "$CONFIG_PATH"

  systemctl daemon-reload
  systemctl enable dployr-base >/dev/null 2>&1 || true
  systemctl restart dployr-base 2>/dev/null || systemctl start dployr-base

  sleep 2

  if systemctl is-active --quiet dployr-base; then
    info "dployr-base is running"
  else
    warn "dployr-base failed to start — check: journalctl -u dployr-base -n 50"
  fi

  echo ""
  echo "Installation complete"
  echo ""
  echo "  Config : $CONFIG_PATH"
  echo "  Logs   : journalctl -u dployr-base -f"
  echo ""
  echo "To reconfigure: sudo bash $0"
}

main
