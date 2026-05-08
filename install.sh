#!/bin/bash

# Copyright 2025 Emmanuel Madehin
# SPDX-License-Identifier: Apache-2.0

set -eu

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin:$PATH"

# Include nvm-managed node if present
if [ -d "/root/.nvm/versions/node" ]; then
  NVM_NODE_BIN=$(find /root/.nvm/versions/node -maxdepth 2 -name bin -type d 2>/dev/null | sort -V | tail -1)
  [ -n "$NVM_NODE_BIN" ] && export PATH="$NVM_NODE_BIN:$PATH"
fi

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


info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*"; }
error() { echo "[ERROR] $*"; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || error "$1 is required but not installed"; }

NODE_BIN=""

detect_node() {
  if /usr/local/bin/node --version >/dev/null 2>&1; then
    NODE_BIN="/usr/local/bin/node"
    info "Using node: $NODE_BIN ($($NODE_BIN --version))"
    return
  fi

  local candidates=() seen_versions=()
  while IFS= read -r p; do
    local ver; ver="$("$p" --version 2>/dev/null || echo "")"
    [[ -z "$ver" || " ${seen_versions[*]} " == *" $ver "* ]] && continue
    seen_versions+=("$ver")
    candidates+=("$p")
  done < <(find /usr/local/bin /usr/bin /usr/local/sbin /usr/sbin \
    /root/.nvm/versions/node/*/bin \
    /home/*/.nvm/versions/node/*/bin \
    -maxdepth 1 -name node 2>/dev/null \
    | sort -t/ -k7 -V -r)

  [ ${#candidates[@]} -eq 0 ] && error "node is required but not found on this system"

  if [ ${#candidates[@]} -eq 1 ] || $SKIP_PROMPTS; then
    NODE_BIN="${candidates[0]}"
  else
    echo ""
    echo "Node.js installations found:"
    local i=1
    for p in "${candidates[@]}"; do
      local ver; ver="$("$p" --version 2>/dev/null || echo unknown)"
      printf "  %d) %s  (%s)\n" "$i" "$p" "$ver"
      ((i++))
    done
    echo ""
    printf "Select node to use [1]: "
    local choice; read -r choice
    choice="${choice:-1}"
    NODE_BIN="${candidates[$((choice - 1))]}"
  fi

  info "Using node: $NODE_BIN ($($NODE_BIN --version))"
  if [ "$NODE_BIN" != "/usr/local/bin/node" ]; then
    cp "$NODE_BIN" /usr/local/bin/node.new
    mv /usr/local/bin/node.new /usr/local/bin/node
    chmod 755 /usr/local/bin/node
  fi
  NODE_BIN="/usr/local/bin/node"
}

install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    info "Caddy already installed: $(caddy version)"
    return
  fi
  info "Installing Caddy..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https >/dev/null 2>&1
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update >/dev/null 2>&1
  apt-get install -y caddy >/dev/null 2>&1
}

setup_caddy() {
  local domain="$1" app_port="$2"

  cat > /etc/caddy/Caddyfile <<EOF
${domain} {
    tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key
    reverse_proxy localhost:${app_port}
}
EOF

  systemctl enable caddy >/dev/null 2>&1
  systemctl restart caddy
  info "Caddy configured: https://${domain} → localhost:${app_port}"
}

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

  prompt "logging.level"                 "Log level (debug|info|warn|error)"

  prompt "cors.allowed_origins"          "CORS allowed origins"

  prompt "billing.polar_access_token"    "Polar access token"                       true
  prompt "billing.polar_webhook_secret"  "Polar webhook secret"                     true
  prompt "billing.polar_environment"     "Polar environment (sandbox/production)"

  prompt "virtual_machines.provider"     "VM provider (digitalocean)"
  prompt "virtual_machines.do_api_token" "DigitalOcean API token"                   true
  prompt "virtual_machines.ssh_key"      "DigitalOcean SSH key ID"
}

read_pem() {
  local label="$1" dest="$2"
  echo ""
  echo "$label"

  mkdir -p /etc/caddy/certs

  if [ -f "$dest" ]; then
    printf "  Already set. Keep existing value? (y/n) [y]: "
    local keep; read -r keep; keep="${keep:-y}"
    [[ "$keep" == "y" || "$keep" == "Y" ]] && return
  fi

  while true; do
    echo "  [p] Paste content  [f] Enter file path"
    printf "  Choice [p]: "; local mode; read -r mode; mode="${mode:-p}"

    if [[ "$mode" == "f" ]]; then
      while true; do
        printf "  File path: "; local fpath; read -r fpath
        [ -f "$fpath" ] && break
        echo "  File not found: $fpath"
      done
      cp "$fpath" "$dest"
    else
      echo "  Paste content below (reads until -----END line):"
      local line content=""
      while IFS= read -r line; do
        content+="${line}"$'\n'
        [[ "$line" == -----END* ]] && break
      done
      printf '%s' "$content" > "$dest"
    fi

    if openssl pkey -in "$dest" -noout >/dev/null 2>&1; then
      return
    elif openssl x509 -in "$dest" -noout >/dev/null 2>&1; then
      return
    else
      echo "  ERROR: Invalid PEM file. Please try again."
      rm -f "$dest"
    fi
  done
}

prompt_caddy() {
  $SKIP_PROMPTS && return

  echo ""
  printf "Set up Caddy reverse proxy? (y/n): "
  local choice; read -r choice
  [[ "$choice" != "y" && "$choice" != "Y" ]] && return

  local domain app_port
  printf "Domain [base.dployr.io]: "; read -r domain; domain="${domain:-base.dployr.io}"
  printf "App port [7878]: "; read -r app_port; app_port="${app_port:-7878}"

  read_pem "Cloudflare origin certificate" /etc/caddy/certs/origin.pem
  read_pem "Cloudflare origin private key"  /etc/caddy/certs/origin.key
  chown caddy:caddy /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key
  chmod 640 /etc/caddy/certs/origin.pem
  chmod 600 /etc/caddy/certs/origin.key

  install_caddy
  setup_caddy "$domain" "$app_port"
}

main() {
  echo ""
  echo "Dployr Base Installer"
  echo ""

  [ "$EUID" -ne 0 ] && error "Run as root"

  if ! $SKIP_PROMPTS && [ -e /dev/tty ]; then
    exec < /dev/tty
  elif ! $SKIP_PROMPTS; then
    SKIP_PROMPTS=true
  fi
  require curl
  require jq

  detect_node
  install_tomato

  local gh_args=(-fsSL)
  [ -n "${GITHUB_TOKEN:-}" ] && gh_args+=(-H "Authorization: Bearer $GITHUB_TOKEN")

  if [ "$VERSION" = "latest" ]; then
    VERSION="$(curl "${gh_args[@]}" "https://api.github.com/repos/${REPO}/releases/latest" \
      | jq -r '.tag_name')"
    [ -z "$VERSION" ] || [ "$VERSION" = "null" ] && error "Failed to resolve latest version — for private repos, set GITHUB_TOKEN"
  fi

  info "Version: $VERSION"
  info "Installing to $INSTALL_DIR"

  id "$SERVICE_USER" &>/dev/null || useradd --system --no-create-home --shell /bin/false "$SERVICE_USER"
  mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" /var/log/dployr-base /var/lib/dployr-base/storage

  local asset_name="dployr-base-${VERSION}.tar.gz"
  local asset_url
  asset_url="$(curl "${gh_args[@]}" "https://api.github.com/repos/${REPO}/releases/tags/${VERSION}" \
    | jq -r --arg name "$asset_name" '.assets[] | select(.name == $name) | .url')"
  [ -z "$asset_url" ] || [ "$asset_url" = "null" ] && error "Failed to find release asset: ${asset_name}"

  curl "${gh_args[@]}" -H "Accept: application/octet-stream" "$asset_url" | tar -xz -C "$INSTALL_DIR"

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
  prompt_caddy

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
ExecStart=$NODE_BIN --import tsx $INSTALL_DIR/src/index.ts
Restart=always
RestartSec=10
StandardOutput=append:/var/log/dployr-base/output.log
StandardError=append:/var/log/dployr-base/output.log

[Install]
WantedBy=multi-user.target
EOF

  info "Configuring log rotation..."

  cat > /etc/logrotate.d/dployr-base <<EOF
/var/log/dployr-base/output.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
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

main "$@"
exit 0
