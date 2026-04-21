#!/bin/bash

# Copyright 2025 Emmanuel Madehin
# SPDX-License-Identifier: Apache-2.0

set -e

# Dployr Base Installer

VERSION="${VERSION:-latest}"
INSTALL_DIR="${INSTALL_DIR:-/opt/dployr-base}"
CONFIG_DIR="/etc/dployr-base"
SERVICE_USER="dployr"

INTERACTIVE="${INTERACTIVE:-true}"
SKIP_PROMPTS="${SKIP_PROMPTS:-false}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --non-interactive|-y)
      INTERACTIVE="false"
      SKIP_PROMPTS="true"
      shift
      ;;
    -v|--version)
      VERSION="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

download_template() {
  local version="$1"
  local out="$2"

  local url="https://raw.githubusercontent.com/dployr-io/dployr-base/${version}/config.example.toml"

  curl -fsSL "$url" -o "$out" || {
    echo "[WARN] Falling back to main template"
    curl -fsSL "https://raw.githubusercontent.com/dployr-io/dployr-base/main/config.example.toml" -o "$out" || {
      echo "[ERROR] Failed to download config template"
      exit 1
    }
  }
}

echo "Dployr Base Installer"
echo "====================="
echo "[INFO] Installing to $INSTALL_DIR"

if [ "$EUID" -ne 0 ]; then
  echo "[ERROR] Run as root"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is required but not installed"
  exit 1
fi

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux) PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *) echo "[ERROR] Unsupported OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
  *) echo "[ERROR] Unsupported arch"; exit 1 ;;
esac

if ! id "$SERVICE_USER" &>/dev/null; then
  useradd --system --no-create-home --shell /bin/false "$SERVICE_USER"
fi

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" /var/log/dployr-base /var/lib/dployr-base/storage

if [ "$VERSION" = "latest" ]; then
  VERSION="$(curl -fsSL https://api.github.com/repos/dployr-io/dployr-base/releases/latest \
    | grep -m1 '"tag_name"' \
    | sed 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/')"

  [ -z "$VERSION" ] && { echo "[ERROR] Failed to resolve version"; exit 1; }
fi

echo "[INFO] Version: $VERSION"

DOWNLOAD_URL="https://github.com/dployr-io/dployr-base/releases/download/${VERSION}/dployr-base-${VERSION}.tar.gz"

curl -fsSL "$DOWNLOAD_URL" | tar -xz -C "$INSTALL_DIR"

temp_template=$(mktemp)
download_template "$VERSION" "$temp_template"

echo "[INFO] Installing dependencies..."

cd "$INSTALL_DIR"
npm install --omit=dev

echo "[INFO] Processing configuration..."

node "scripts/process-config.cjs" "$temp_template" "$CONFIG_DIR/config.toml" "$SKIP_PROMPTS"

cat > /etc/systemd/system/dployr-base.service <<EOF
[Unit]
Description=Dployr Base

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
chmod 600 "$CONFIG_DIR/config.toml"

systemctl daemon-reload
systemctl enable dployr-base >/dev/null 2>&1 || true
systemctl restart dployr-base || systemctl start dployr-base

echo ""
echo "Installation completed"
