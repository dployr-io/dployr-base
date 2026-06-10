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
LISTMONK_VERSION="${LISTMONK_VERSION:-6.1.0}"
LISTMONK_DIR="/opt/listmonk"
LISTMONK_CONFIG_DIR="/etc/listmonk"
LISTMONK_CONFIG="$LISTMONK_CONFIG_DIR/config.toml"
LISTMONK_USER="listmonk"

LOKI_VERSION="${LOKI_VERSION:-3.7.2}"
LOKI_DIR="/var/lib/loki"
LOKI_CONFIG_DIR="/etc/loki"
LOKI_CONFIG="$LOKI_CONFIG_DIR/config.yaml"
LOKI_USER="loki"

SKIP_PROMPTS=false

set +u; _self="${BASH_SOURCE[0]:-}"; set -u
if [[ -z "$_self" || "$_self" == "$0" ]]; then
  while [[ $# -gt 0 ]]; do
    case $1 in
      --non-interactive|-y) SKIP_PROMPTS=true; shift ;;
      -v|--version) VERSION="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
fi


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

caddy_upsert_block() {
  local domain="$1" block="$2" file="/etc/caddy/Caddyfile"
  # Remove existing block for domain (tracks brace depth so nested {} are safe)
  awk -v d="$domain {" '
    !found && $0 == d { found=1; depth=0 }
    found { for(i=1;i<=length($0);i++) { c=substr($0,i,1); if(c=="{") depth++; if(c=="}") { depth--; if(depth==0){ found=0; next } } }; next }
    { print }
  ' "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
  printf '\n%s\n' "$block" >> "$file"
}

render_caddyfile() {
  local domain="$1" app_port="$2"
  cat <<EOF
:80 {
    error 403
}

:443 {
    tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key
    error 403
}

${domain} {
    tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key
    reverse_proxy localhost:${app_port}
}
EOF
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

  render_caddyfile "$domain" "$app_port" > /etc/caddy/Caddyfile
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

# Normalise any user input into a TOML array string, e.g.:
#   102.88.54.231              → ["102.88.54.231"]
#   102.88.54.231, 1.1.1.1    → ["102.88.54.231", "1.1.1.1"]
#   ["102.88.54.231"]          → ["102.88.54.231"]   (passed through)
normalize_toml_array() {
  local input="$1"
  # Already a TOML array — pass through
  if [[ "$input" =~ ^\[.*\]$ ]]; then
    echo "$input"
    return
  fi
  # Comma-separated values — split, quote each, wrap
  local result='['
  local first=true
  IFS=',' read -ra parts <<< "$input"
  for part in "${parts[@]}"; do
    part="${part#"${part%%[![:space:]]*}"}"  # ltrim
    part="${part%"${part##*[![:space:]]}"}"  # rtrim
    part="${part#\"}" ; part="${part%\"}"    # strip existing quotes
    $first || result+=', '
    result+="\"$part\""
    first=false
  done
  result+=']'
  echo "$result"
}

prompt_array() {
  local key="$1" label="$2"
  local current; current="$(tget "$key")"

  $SKIP_PROMPTS && return

  if [ -n "$current" ]; then
    printf "%s [%s] Keep this value? (y/n): " "$label" "$current"
    local choice; read -r choice
    case "$choice" in
      ""|"y"|"Y") return 0 ;;
      "n"|"N") ;;
      *) tset "$key" "$choice"; return 0 ;;
    esac
  fi

  printf "%s (e.g. 1.2.3.4 or 1.2.3.4, 5.6.7.8): " "$label"
  local val; read -r val
  [ -n "$val" ] && tset "$key" "$val"
  return 0
}

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
  prompt_array "admin.allowed_ips"       "Allowed admin IPs"

  prompt "integrations.github_token"     "GitHub personal access token"             true

  prompt "email.provider"                "Email provider"
  prompt "email.from_address"            "From address"
  prompt "email.zepto_api_key"           "Zepto API key"                            true

  prompt "security.encryption_key"       "Encryption key (AES-256, hex 32 bytes)"   true
  prompt "security.session_ttl"          "Session TTL (seconds)"
  prompt "security.turnstile_secret_key" "Cloudflare Turnstile secret key"          true

  prompt "logging.level"                 "Log level (debug|info|warn|error)"

  prompt "cors.allowed_origins"          "CORS allowed origins"

  prompt "billing.polar_access_token"        "Polar access token"                       true
  prompt "billing.polar_webhook_secret"      "Polar webhook secret"                     true
  prompt "billing.polar_environment"         "Polar environment (sandbox/production)"
  prompt "billing.product_ids.indie_monthly"  "Polar product ID — Indie Monthly (UUID)"
  prompt "billing.product_ids.indie_annual"   "Polar product ID — Indie Annual (UUID)"
  prompt "billing.product_ids.pro_monthly"    "Polar product ID — Pro Monthly (UUID)"
  prompt "billing.product_ids.pro_annual"     "Polar product ID — Pro Annual (UUID)"

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

render_vector_config() {
  local loki_url="$1" with_listmonk="${2:-false}"
  local listmonk_source="" inputs='"dployr_base"'
  if $with_listmonk; then
    listmonk_source='
[sources.listmonk]
type    = "file"
include = ["/var/log/listmonk/output.log"]
'
    inputs='"dployr_base", "listmonk"'
  fi
  cat <<EOF
[api]
enabled = true
address = "127.0.0.1:8686"

[sources.dployr_base]
type    = "file"
include = ["/var/log/dployr-base/output.log"]
${listmonk_source}
[sinks.loki]
type     = "loki"
inputs   = [${inputs}]
endpoint = "${loki_url}"
encoding.codec = "text"

[sinks.loki.labels]
host   = "{{ host }}"
source = "dployr-base"
EOF
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
  local loki_url; loki_url="$(tget 'loki.url')"

  [ -z "$loki_url" ] && return

  install_vector

  local with_listmonk=false
  command -v listmonk >/dev/null 2>&1 && with_listmonk=true

  mkdir -p /etc/vector
  render_vector_config "$loki_url" "$with_listmonk" > /etc/vector/vector.toml

  usermod -aG "$SERVICE_USER" vector >/dev/null 2>&1 || true
  chmod g+rX /var/log/dployr-base >/dev/null 2>&1 || true

  systemctl daemon-reload
  systemctl enable vector >/dev/null 2>&1
  systemctl restart vector
  info "Vector configured → Loki"
}

install_listmonk_binary() {
  if command -v listmonk >/dev/null 2>&1; then
    local installed; installed="$(listmonk version 2>/dev/null | grep -oP 'v\K[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "")"
    if [ "$installed" = "$LISTMONK_VERSION" ]; then
      info "Listmonk already at v${LISTMONK_VERSION}, skipping download"
      return
    fi
    info "Upgrading Listmonk v${installed} → v${LISTMONK_VERSION}..."
  else
    info "Downloading Listmonk v${LISTMONK_VERSION}..."
  fi
  local url="https://github.com/knadh/listmonk/releases/download/v${LISTMONK_VERSION}/listmonk_${LISTMONK_VERSION}_linux_amd64.tar.gz"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "$url" -o "$tmp/listmonk.tar.gz" || { rm -rf "$tmp"; error "Failed to download Listmonk"; }
  tar -xzf "$tmp/listmonk.tar.gz" -C "$tmp"   || { rm -rf "$tmp"; error "Failed to extract Listmonk"; }
  systemctl stop listmonk 2>/dev/null || true
  mv "$tmp/listmonk" /usr/local/bin/listmonk
  chmod +x /usr/local/bin/listmonk
  rm -rf "$tmp"
  info "Listmonk v${LISTMONK_VERSION} installed"
}

# Parse postgresql://user:pass@host:port/dbname into named variables.
# Usage: parse_pg_url "$url" host_var port_var user_var pass_var name_var
parse_pg_url() {
  local url="$1"
  if [[ "$url" =~ ^postgres(ql)?://([^:]+):([^@]+)@([^:/]+):([0-9]+)/([^?]+) ]]; then
    printf -v "$2" '%s' "${BASH_REMATCH[4]}"  # host
    printf -v "$3" '%s' "${BASH_REMATCH[5]}"  # port
    printf -v "$4" '%s' "${BASH_REMATCH[2]}"  # user
    printf -v "$5" '%s' "${BASH_REMATCH[3]}"  # pass
    printf -v "$6" '%s' "${BASH_REMATCH[6]}"  # dbname
    return 0
  fi
  return 1
}

# Poll until the Listmonk API responds (max 90 s).
listmonk_api_ready() {
  local i=0
  info "Waiting for Listmonk API..."
  while [ $i -lt 30 ]; do
    if curl -sf --max-time 3 "http://localhost:9000/health" >/dev/null 2>&1; then
      info "Listmonk API is ready"
      return 0
    fi
    sleep 3; ((i++))
    info "  still waiting... (${i}/30)"
  done
  return 1
}

build_smtp_patch() {
  local current="$1" root_url="$2" from_addr="$3" zepto_key="$4" base_url="$5" from_name="$6" cors_json="$7"
  local logo_url="${base_url}/icon.png"
  local favicon_url="${base_url}/favicon.ico"
  # Build RFC 5322 display name format: "Name <email>" or plain email if no name
  local from_field="$from_addr"
  [ -n "$from_name" ] && from_field="${from_name} <${from_addr}>"
  echo "$current" | jq \
    --arg url       "$root_url"     \
    --arg from      "$from_field"   \
    --arg pass      "$zepto_key"    \
    --arg logo      "$logo_url"     \
    --arg favicon   "$favicon_url"  \
    --argjson cors  "$cors_json"    \
    '."app.root_url"              = $url     |
     ."app.from_email"            = $from    |
     ."app.logo_url"              = $logo    |
     ."app.favicon_url"           = $favicon |
     ."security.cors_origins"     = $cors    |
     ."app.bounce_enable_webhooks" = true |
     ."app.bounce_hard_threshold"  = 1    |
     ."app.bounce_soft_threshold"  = 2    |
     .smtp = [{
       "enabled":         true,
       "host":            "smtp.zeptomail.com",
       "port":            2525,
       "auth_protocol":   "login",
       "username":        "emailapikey",
       "password":        $pass,
       "hello_hostname":  "",
       "max_conns":       10,
       "idle_timeout":    "15s",
       "wait_timeout":    "5s",
       "retries":         2,
       "tls_type":        "STARTTLS",
       "tls_skip_verify": false,
       "email_headers":   []
     }]'
}

# Log in via the Listmonk web form; writes a session cookie jar and prints its path.
# v6 removed Basic Auth for admin users — session cookies work for API calls.
listmonk_web_login() {
  local lm_user="$1" lm_pass="$2"
  local jar; jar="$(mktemp)"

  # Fetch login page to obtain the nonce cookie + nonce hidden field value
  local html
  html="$(curl -sf --max-time 5 -c "$jar" http://localhost:9000/admin/login)" || {
    rm -f "$jar"; warn "Listmonk: could not reach login page"; return 1
  }
  local nonce
  nonce="$(printf '%s' "$html" | grep -oP 'name="nonce"\s+value="\K[^"]+')"
  if [ -z "$nonce" ]; then
    rm -f "$jar"; warn "Listmonk: could not extract login nonce"; return 1
  fi

  # POST the login form — a 302 redirect means success
  local code
  code="$(curl -s --max-time 5 -b "$jar" -c "$jar" \
    -o /dev/null -w "%{http_code}" \
    --data-urlencode "username=$lm_user" \
    --data-urlencode "password=$lm_pass" \
    --data-urlencode "nonce=$nonce" \
    --data-urlencode "next=/admin" \
    -X POST http://localhost:9000/admin/login)"

  if [[ "$code" == "302" ]]; then
    echo "$jar"; return 0
  fi
  rm -f "$jar"
  warn "Listmonk: web login failed (HTTP $code) — check credentials"
  return 1
}

# Configure SMTP + root URL in Listmonk via PUT /api/settings.
# Pulls ZeptoMail key + from address from the already-configured [email] section.
# Strip the first subdomain from a URL, preserving the scheme.
# e.g. https://app.dployr.io → https://dployr.io
strip_subdomain() {
  echo "$1" | sed -E 's|^(https?://)[^.]+\.([^.]+\..+)|\1\2|'
}

listmonk_configure_smtp() {
  local jar="$1" root_url="$2" base_url="$3"
  local api="http://localhost:9000/api"
  local zepto_key from_addr from_name
  zepto_key="$(tget 'email.zepto_api_key')"
  from_addr="$(tget 'listmonk.from_address')"
  from_name="$(tget 'listmonk.from_name')"
  # Derive CORS origins from server.app_url: strip subdomain to get root domain
  # e.g. https://app.dployr.io → https://dployr.io
  local app_url root_origin cors_json
  app_url="$(tget 'server.app_url')"
  root_origin="$(strip_subdomain "$app_url")"
  cors_json="$(jq -cn --arg root "$root_origin" --arg app "$app_url" '[$root, $app]')"

  if [ -z "$zepto_key" ]; then
    warn "Listmonk: email.zepto_api_key not set — SMTP skipped"
    return
  fi
  [ -z "$from_addr" ] && from_addr="$(tget 'email.from_address')"

  local current
  current="$(curl -sf --max-time 5 -b "$jar" "${api}/settings" | jq '.data')"
  if [ -z "$current" ] || [ "$current" = "null" ]; then
    warn "Listmonk: could not read settings — SMTP not configured"
    return
  fi

  local patched
  patched="$(build_smtp_patch "$current" "$root_url" "$from_addr" "$zepto_key" "$base_url" "$from_name" "$cors_json")"

  local ok
  ok="$(curl -sf --max-time 5 -X PUT -b "$jar" \
    -H "Content-Type: application/json" \
    -d "$patched" "${api}/settings" | jq -r '.data')"

  if [ "$ok" = "true" ]; then
    info "Listmonk: SMTP + root URL configured"
  else
    warn "Listmonk: SMTP config failed — check journalctl -u listmonk"
  fi
}

# Create the Newsletter list via POST /api/lists.
# Idempotent — returns existing UUID if the list already exists.
# Prints ONLY the UUID to stdout; all logging done by the caller.
listmonk_create_list() {
  local jar="$1"
  local api="http://localhost:9000/api"

  local existing_uuid
  existing_uuid="$(curl -sf --max-time 5 -b "$jar" "${api}/lists?page=1&per_page=100" \
    | jq -r '.data.results[] | select(.name == "Newsletter") | .uuid' 2>/dev/null | head -1)"
  if [ -n "$existing_uuid" ]; then
    echo "$existing_uuid"; return 0
  fi

  local resp uuid
  resp="$(curl -sf --max-time 5 -X POST -b "$jar" \
    -H "Content-Type: application/json" \
    -d '{"name":"Newsletter","type":"public","optin":"single","tags":["newsletter"]}' \
    "${api}/lists")"
  uuid="$(echo "$resp" | jq -r '.data.uuid // empty' 2>/dev/null)"

  if [ -n "$uuid" ]; then
    echo "$uuid"; return 0
  fi
  return 1
}

render_listmonk_config() {
  local public_url="$1" db_host="$2" db_port="$3" db_user="$4" db_pass="$5" db_name="$6"
  cat <<EOF
[app]
address    = "localhost:9000"
public_url = "${public_url}"

[db]
host         = "${db_host}"
port         = ${db_port}
user         = "${db_user}"
password     = "${db_pass}"
database     = "${db_name}"
ssl_mode     = "require"
max_open     = 2
max_idle     = 1
max_lifetime = "300s"
EOF
}

render_listmonk_unit() {
  local listmonk_user="$1" listmonk_dir="$2" listmonk_config="$3"
  cat <<EOF
[Unit]
Description=Listmonk — mailing list and newsletter manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${listmonk_user}
WorkingDirectory=${listmonk_dir}
ExecStart=/usr/local/bin/listmonk --config ${listmonk_config}
Restart=always
RestartSec=10
StandardOutput=append:/var/log/listmonk/output.log
StandardError=append:/var/log/listmonk/output.log

[Install]
WantedBy=multi-user.target
EOF
}

prompt_listmonk() {
  $SKIP_PROMPTS && return

  echo ""
  printf "Install Listmonk (newsletter & mailing list manager)? (y/n): "
  local choice; read -r choice
  [[ "$choice" != "y" && "$choice" != "Y" ]] && return

  prompt "listmonk.url"             "Listmonk domain URL (e.g. https://lists.dployr.io)"
  prompt "listmonk.from_address"    "Newsletter from address (e.g. hello@dployr.io)"
  prompt "listmonk.from_name"       "Newsletter sender name (e.g. Emmanuel from dployr)"
  prompt "listmonk.admin_user"    "Listmonk admin username"
  prompt "listmonk.admin_password" "Listmonk admin password" true
  prompt "listmonk.database_url"  "Listmonk database URL"    true

  local domain lm_user lm_pass lm_pg_url
  domain="$(tget 'listmonk.url' 2>/dev/null || true)"
  domain="${domain#https://}"
  lm_user="$(tget 'listmonk.admin_user' 2>/dev/null || true)"
  lm_pass="$(tget 'listmonk.admin_password' 2>/dev/null || true)"
  lm_pg_url="$(tget 'listmonk.database_url' 2>/dev/null || true)"

  [ -z "$domain" ]    && { warn "Listmonk URL is required — skipping"; return; }
  [ -z "$lm_user" ]   && { warn "Listmonk admin username is required — skipping"; return; }
  [ -z "$lm_pass" ]   && { warn "Listmonk admin password is required — skipping"; return; }
  [ -z "$lm_pg_url" ] && { warn "Listmonk database URL is required — skipping"; return; }

  # Dedicated Listmonk database — isolated from the main dployr-base DB for security

  local db_host db_port db_user db_pass db_name
  parse_pg_url "$lm_pg_url" db_host db_port db_user db_pass db_name \
    || error "Could not parse listmonk.database_url (expected postgresql://user:pass@host:port/dbname)"
  info "Listmonk database: ${db_name} @ ${db_host}:${db_port}"

  # Install binary 
  install_listmonk_binary

  # Create user and directories 
  id "$LISTMONK_USER" &>/dev/null || useradd --system --no-create-home --shell /bin/false "$LISTMONK_USER"
  mkdir -p "$LISTMONK_DIR" "$LISTMONK_CONFIG_DIR" /var/log/listmonk

  # Write config.toml (app + db only — everything else via API)
  render_listmonk_config "https://${domain}" "$db_host" "$db_port" "$db_user" "$db_pass" "$db_name" > "$LISTMONK_CONFIG"

  chmod 600 "$LISTMONK_CONFIG"
  chown -R "$LISTMONK_USER:$LISTMONK_USER" "$LISTMONK_DIR" "$LISTMONK_CONFIG_DIR" /var/log/listmonk

  # Bootstrap DB schema — pass admin credentials as env vars (v4+ method)
  info "Bootstrapping Listmonk database..."
  LISTMONK_ADMIN_USER="$lm_user" LISTMONK_ADMIN_PASSWORD="$lm_pass" \
    listmonk --config "$LISTMONK_CONFIG" --install --yes \
    || warn "DB bootstrap failed — run manually: listmonk --config $LISTMONK_CONFIG --install"

  # Systemd unit
  info "Creating Listmonk systemd service..."
  render_listmonk_unit "$LISTMONK_USER" "$LISTMONK_DIR" "$LISTMONK_CONFIG" > /etc/systemd/system/listmonk.service

  # Log rotation 
  cat > /etc/logrotate.d/listmonk <<EOF
/var/log/listmonk/output.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF

  # Caddy vhost (appended if Caddy is already configured)
  if command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/Caddyfile ]; then
    caddy_upsert_block "$domain" "${domain} {
    tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key
    reverse_proxy localhost:9000 {
      header_up Host {http.request.host}
    }
}"
    systemctl reload caddy 2>/dev/null || true
    info "Caddy: https://${domain} -> localhost:9000"
  fi

  # Start service 
  systemctl daemon-reload
  systemctl enable listmonk >/dev/null 2>&1
  systemctl restart listmonk 2>/dev/null || systemctl start listmonk

  # Configure everything via API (no UI required)
  if listmonk_api_ready; then
    local lm_jar
    lm_jar="$(listmonk_web_login "$lm_user" "$lm_pass")" || lm_jar=""

    local base_url; base_url="$(tget 'server.base_url')"
    if [ -n "$lm_jar" ]; then
      listmonk_configure_smtp "$lm_jar" "https://${domain}" "$base_url"
    else
      warn "Listmonk: could not log in — SMTP not configured"
    fi

    local list_uuid=""
    if [ -n "${lm_jar:-}" ]; then
      if list_uuid="$(listmonk_create_list "$lm_jar")"; then
        info "Listmonk: Newsletter list ready (${list_uuid})"
      else
        warn "Listmonk: Newsletter list creation failed"
      fi
    fi

    # Generate a bounce webhook secret and persist it
    local bounce_secret
    bounce_secret="$(openssl rand -hex 32)"

    tset "listmonk.enabled"               "true"
    tset "listmonk.url"                   "https://${domain}"
    tset "listmonk.admin_user"            "$lm_user"
    tset "listmonk.admin_password"        "$lm_pass"
    tset "listmonk.bounce_webhook_secret" "$bounce_secret"
    [ -n "$list_uuid" ] && tset "listmonk.list_uuid" "$list_uuid"

    local bounce_url="${base_url}/webhooks/zepto/bounce"

    echo ""
    echo "  ┌─ ZeptoMail bounce webhook ──────────────────────────────────────┐"
    echo "  │ ZeptoMail dashboard → Mail Agents → <agent> → Webhooks → Add   │"
    echo "  │                                                                  │"
    echo "  │  Webhook URL : ${bounce_url}"
    echo "  │                                                                  │"
    echo "  │  Authorization headers:                                          │"
    echo "  │    Key   : Authorization                                         │"
    echo "  │    Value : Bearer ${bounce_secret}"
    echo "  │                                                                  │"
    echo "  │  Events to select: Hard bounces  Feedback loop                  │"
    echo "  └──────────────────────────────────────────────────────────────────┘"
    echo ""
    [ -n "${lm_jar:-}" ] && rm -f "$lm_jar"
  else
    warn "Listmonk API not ready — check: journalctl -u listmonk -n 50"
    tset "listmonk.enabled"        "true"
    tset "listmonk.url"            "https://${domain}"
    tset "listmonk.admin_user"     "$lm_user"
    tset "listmonk.admin_password" "$lm_pass"
  fi

  if systemctl is-active --quiet listmonk; then
    info "Listmonk is running"
  else
    warn "Listmonk failed to start — check: journalctl -u listmonk -n 50"
  fi

  echo ""
  echo "  Listmonk admin : https://${domain}/admin"
  echo "  Config         : $LISTMONK_CONFIG"
  echo "  Logs           : journalctl -u listmonk -f"
  echo ""
}

install_loki_binary() {
  if command -v loki >/dev/null 2>&1; then
    local installed; installed="$(loki --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo "")"
    if [ "$installed" = "$LOKI_VERSION" ]; then
      info "Loki already at v${LOKI_VERSION}, skipping download"
      return
    fi
    info "Upgrading Loki v${installed} → v${LOKI_VERSION}..."
  else
    info "Downloading Loki v${LOKI_VERSION}..."
  fi

  command -v unzip >/dev/null 2>&1 || apt-get install -y unzip >/dev/null 2>&1

  local url="https://github.com/grafana/loki/releases/download/v${LOKI_VERSION}/loki-linux-amd64.zip"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "$url" -o "$tmp/loki.zip"          || { rm -rf "$tmp"; error "Failed to download Loki"; }
  unzip -q "$tmp/loki.zip" -d "$tmp"             || { rm -rf "$tmp"; error "Failed to extract Loki"; }
  systemctl stop loki 2>/dev/null || true
  mv "$tmp/loki-linux-amd64" /usr/local/bin/loki
  chmod +x /usr/local/bin/loki
  rm -rf "$tmp"
  info "Loki v${LOKI_VERSION} installed"
}

render_loki_config() {
  local account_id="$1" access_key="$2" secret_key="$3" bucket="$4"
  cat <<EOF
auth_enabled: false

server:
  http_listen_port: 3100
  grpc_listen_port: 9096
  log_level: warn

common:
  instance_addr: 127.0.0.1
  path_prefix: ${LOKI_DIR}
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2024-04-01
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: index_
        period: 24h

storage_config:
  aws:
    bucketnames: ${bucket}
    endpoint: https://${account_id}.r2.cloudflarestorage.com
    access_key_id: ${access_key}
    secret_access_key: ${secret_key}
    s3forcepathstyle: true
    region: auto
  tsdb_shipper:
    active_index_directory: ${LOKI_DIR}/index
    cache_location: ${LOKI_DIR}/index_cache

limits_config:
  retention_period: 26280h

compactor:
  working_directory: ${LOKI_DIR}/compactor
  compaction_interval: 10m
  retention_enabled: true
  retention_delete_delay: 2h
  retention_delete_worker_count: 150
  delete_request_store: s3
EOF
}

render_loki_unit() {
  local loki_user="$1" loki_config="$2"
  cat <<EOF
[Unit]
Description=Loki — log aggregation system
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${loki_user}
ExecStart=/usr/local/bin/loki -config.file=${loki_config}
Restart=always
RestartSec=10
StandardOutput=append:/var/log/loki/output.log
StandardError=append:/var/log/loki/output.log

[Install]
WantedBy=multi-user.target
EOF
}

prompt_loki() {
  $SKIP_PROMPTS && return

  echo ""
  printf "Install Loki (centralised log aggregation → Cloudflare R2)? (y/n): "
  local choice; read -r choice
  [[ "$choice" != "y" && "$choice" != "Y" ]] && return

  prompt "loki.r2_account_id" "Cloudflare account ID"
  prompt "loki.r2_bucket"     "R2 bucket name (e.g. dployr-logs)"
  prompt "loki.r2_access_key" "R2 access key ID"      true
  prompt "loki.r2_secret_key" "R2 secret access key"  true

  local account_id bucket access_key secret_key
  account_id="$(tget 'loki.r2_account_id')"
  bucket="$(tget 'loki.r2_bucket')"
  access_key="$(tget 'loki.r2_access_key')"
  secret_key="$(tget 'loki.r2_secret_key')"

  [ -z "$account_id" ] && { warn "Cloudflare account ID required — skipping Loki"; return; }
  [ -z "$bucket" ]     && { warn "R2 bucket name required — skipping Loki"; return; }
  [ -z "$access_key" ] && { warn "R2 access key required — skipping Loki"; return; }
  [ -z "$secret_key" ] && { warn "R2 secret key required — skipping Loki"; return; }

  install_loki_binary

  id "$LOKI_USER" &>/dev/null || useradd --system --no-create-home --shell /bin/false "$LOKI_USER"
  mkdir -p "${LOKI_DIR}"/{index,index_cache,compactor} "$LOKI_CONFIG_DIR" /var/log/loki

  render_loki_config "$account_id" "$access_key" "$secret_key" "$bucket" > "$LOKI_CONFIG"
  chmod 600 "$LOKI_CONFIG"
  chown -R "$LOKI_USER:$LOKI_USER" "$LOKI_DIR" "$LOKI_CONFIG_DIR" /var/log/loki

  render_loki_unit "$LOKI_USER" "$LOKI_CONFIG" > /etc/systemd/system/loki.service

  cat > /etc/logrotate.d/loki <<EOF
/var/log/loki/output.log {
    weekly
    rotate 4
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF

  systemctl daemon-reload
  systemctl enable loki >/dev/null 2>&1
  systemctl restart loki 2>/dev/null || systemctl start loki

  tset "loki.enabled" "true"
  tset "loki.url"     "http://localhost:3100"

  sleep 2
  if systemctl is-active --quiet loki; then
    info "Loki is running → http://localhost:3100"
  else
    warn "Loki failed to start — check: journalctl -u loki -n 50"
  fi

  local viewer_token
  viewer_token="$(tget 'loki.viewer_token')"
  [ -z "$viewer_token" ] && viewer_token="$(openssl rand -hex 32)"
  tset "loki.viewer_token" "$viewer_token"

  if command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/Caddyfile ]; then
    prompt "loki.api_domain"  "Loki API domain (e.g. loki.dployr.io)"
    prompt "loki.logs_origin" "Logs viewer origin for CORS (e.g. https://logs.dployr.io)"

    local loki_api_domain; loki_api_domain="$(tget 'loki.api_domain')"
    local logs_origin; logs_origin="$(tget 'loki.logs_origin')"

    if [ -n "$loki_api_domain" ]; then

      caddy_upsert_block "$loki_api_domain" "${loki_api_domain} {
    tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key

    header Access-Control-Allow-Origin \"${logs_origin:-*}\"
    header Access-Control-Allow-Headers \"Authorization, Content-Type\"
    header Access-Control-Allow-Methods \"GET, OPTIONS\"

    @preflight method OPTIONS
    respond @preflight 204

    @unauth not header Authorization \"Bearer ${viewer_token}\"
    respond @unauth 401

    @write method POST PUT DELETE PATCH
    respond @write 405

    reverse_proxy localhost:3100
}"
      systemctl reload caddy 2>/dev/null || true
      info "Caddy: https://${loki_api_domain} → localhost:3100"
    fi
  fi

  echo ""
  echo "  Loki viewer token : ${viewer_token}"
  echo "  (save this — used to authenticate the log viewer)"
  echo ""
}

setup_redis_aof() {
  local kv_url; kv_url="$(tget 'kv.url')"
  [ -z "$kv_url" ] && return

  if [[ "$kv_url" != *"127.0.0.1"* && "$kv_url" != *"localhost"* ]]; then
    info "Redis appears to be remote — enable AOF persistence on the remote host to prevent data loss"
    return
  fi

  local redis_conf=""
  for f in /etc/redis/redis.conf /etc/redis.conf /usr/local/etc/redis/redis.conf; do
    [ -f "$f" ] && { redis_conf="$f"; break; }
  done

  if [ -z "$redis_conf" ]; then
    warn "Redis config file not found — configure AOF persistence manually to prevent data loss on restart"
    return
  fi

  if grep -q "^appendonly yes" "$redis_conf" 2>/dev/null; then
    info "Redis AOF persistence already enabled"
    return
  fi

  info "Enabling Redis AOF persistence (everysec — max 1 second data loss on crash)..."

  if command -v redis-cli >/dev/null 2>&1; then
    redis-cli CONFIG SET appendonly yes >/dev/null 2>&1 || true
    redis-cli CONFIG SET appendfsync everysec >/dev/null 2>&1 || true
    redis-cli CONFIG REWRITE >/dev/null 2>&1 || true
  fi

  {
    printf '\n# AOF persistence — added by dployr installer\n'
    printf 'appendonly yes\n'
    printf 'appendfsync everysec\n'
    printf 'auto-aof-rewrite-percentage 100\n'
    printf 'auto-aof-rewrite-min-size 64mb\n'
  } >> "$redis_conf"

  systemctl restart redis 2>/dev/null || systemctl restart redis-server 2>/dev/null || true
  info "Redis AOF persistence enabled"
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

  install_caddy
  read_pem "Cloudflare origin certificate" /etc/caddy/certs/origin.pem
  read_pem "Cloudflare origin private key"  /etc/caddy/certs/origin.key
  chown caddy:caddy /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key
  chmod 640 /etc/caddy/certs/origin.pem
  chmod 600 /etc/caddy/certs/origin.key

  setup_caddy "$domain" "$app_port"
}

render_dployr_unit() {
  local install_dir="$1" config_dir="$2" service_user="$3" node_bin="$4" version="$5"
  cat <<EOF
[Unit]
Description=dployr Base
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${service_user}
WorkingDirectory=${install_dir}
Environment="NODE_ENV=production"
Environment="CONFIG_PATH=${config_dir}/config.toml"
Environment="BASE_VERSION=${version}"
ExecStart=${node_bin} --import tsx ${install_dir}/src/index.ts
Restart=always
RestartSec=10
StandardOutput=append:/var/log/dployr-base/output.log
StandardError=append:/var/log/dployr-base/output.log

[Install]
WantedBy=multi-user.target
EOF
}

main() {
  echo ""
  echo "dployr Base Installer"
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
    curl "${gh_args[@]}" -H "Accept: application/vnd.github.raw" \
        "https://api.github.com/repos/${REPO}/contents/config.example.toml?ref=${VERSION}" -o "$CONFIG_PATH" \
      || curl "${gh_args[@]}" -H "Accept: application/vnd.github.raw" \
        "https://api.github.com/repos/${REPO}/contents/config.example.toml?ref=main" -o "$CONFIG_PATH" \
      || error "Failed to download config template"
  fi

  configure
  prompt_caddy
  prompt_listmonk
  setup_redis_aof
  prompt_loki
  setup_vector

  info "Creating systemd service..."

  render_dployr_unit "$INSTALL_DIR" "$CONFIG_DIR" "$SERVICE_USER" "$NODE_BIN" "$VERSION" \
    > /etc/systemd/system/dployr-base.service

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
  echo "  Config        : $CONFIG_PATH"
  echo "  Logs          : journalctl -u dployr-base -f"
  if command -v listmonk >/dev/null 2>&1; then
  echo "  Listmonk logs : journalctl -u listmonk -f"
  echo "  Listmonk cfg  : $LISTMONK_CONFIG"
  fi
  if command -v loki >/dev/null 2>&1; then
  echo "  Loki logs     : journalctl -u loki -f"
  echo "  Loki endpoint : http://localhost:3100"
  echo "  Loki cfg      : $LOKI_CONFIG"
  fi
  echo ""
  echo "To reconfigure: sudo bash $0"
}

set +u; _self="${BASH_SOURCE[0]:-}"; set -u
if [[ -z "$_self" || "$_self" == "$0" ]]; then
  main "$@"
fi
