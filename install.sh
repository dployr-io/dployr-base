#!/usr/bin/env bash
set -e

# Dployr Base Installer
# Usage: 
#   curl -fsSL https://raw.githubusercontent.com/dployr-io/dployr-base/main/install.sh | sudo bash
#   Or with config: sudo bash install.sh --config /path/to/config.toml
#   Or with flags: sudo bash install.sh --kv-type upstash --kv-url "..." --storage-type s3

VERSION="${VERSION:-latest}"
INSTALL_DIR="${INSTALL_DIR:-/opt/dployr-base}"
CONFIG_DIR="/etc/dployr-base"
SERVICE_USER="dployr"

# Default config values (can be overridden by flags or config file)
PORT="7878"
HOST="0.0.0.0"
BASE_URL=""
APP_URL=""
DB_TYPE="postgres"
DB_URL=""
KV_TYPE="redis"
KV_HOST="localhost"
KV_PORT="6379"
KV_USERNAME=""
KV_PASSWORD=""
KV_REST_URL=""
KV_REST_TOKEN=""
STORAGE_TYPE="filesystem"
STORAGE_PATH="/var/lib/dployr-base/storage"
STORAGE_BUCKET=""
STORAGE_REGION=""
STORAGE_ACCESS_KEY=""
STORAGE_SECRET_KEY=""
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""
EMAIL_PROVIDER="zepto"
ZEPTO_API_KEY=""

# Parse command line arguments
CONFIG_FILE=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --app-url)
      APP_URL="$2"
      shift 2
      ;;
    --kv-type)
      KV_TYPE="$2"
      shift 2
      ;;
    --kv-url)
      KV_URL="$2"
      shift 2
      ;;
    --kv-rest-url)
      KV_REST_URL="$2"
      shift 2
      ;;
    --kv-rest-token)
      KV_REST_TOKEN="$2"
      shift 2
      ;;
    --storage-type)
      STORAGE_TYPE="$2"
      shift 2
      ;;
    --storage-bucket)
      STORAGE_BUCKET="$2"
      shift 2
      ;;
    --storage-region)
      STORAGE_REGION="$2"
      shift 2
      ;;
    --storage-access-key)
      STORAGE_ACCESS_KEY="$2"
      shift 2
      ;;
    --storage-secret-key)
      STORAGE_SECRET_KEY="$2"
      shift 2
      ;;
    --google-client-id)
      GOOGLE_CLIENT_ID="$2"
      shift 2
      ;;
    --google-client-secret)
      GOOGLE_CLIENT_SECRET="$2"
      shift 2
      ;;
    --github-client-id)
      GITHUB_CLIENT_ID="$2"
      shift 2
      ;;
    --github-client-secret)
      GITHUB_CLIENT_SECRET="$2"
      shift 2
      ;;
    --zepto-api-key)
      ZEPTO_API_KEY="$2"
      shift 2
      ;;
    -v|--version)
      VERSION="$2"
      shift 2
      ;;
    *)
      echo "[WARN] Unknown option: $1"
      shift
      ;;
  esac
done

echo "Dployr Base Installer"
echo "====================="
echo "[INFO] Installing to $INSTALL_DIR"

# If config file provided, parse it
if [ -n "$CONFIG_FILE" ] && [ -f "$CONFIG_FILE" ]; then
  echo "[INFO] Loading configuration from $CONFIG_FILE"
  
  # Simple TOML parser (reads key = "value" format)
  while IFS='=' read -r key value; do
    # Remove whitespace and quotes
    key=$(echo "$key" | xargs)
    value=$(echo "$value" | xargs | sed 's/^"//;s/"$//')
    
    case "$key" in
      "base_url") BASE_URL="$value" ;;
      "app_url") APP_URL="$value" ;;
      "type") 
        # Determine section context
        if [[ "$CURRENT_SECTION" == "kv" ]]; then
          KV_TYPE="$value"
        elif [[ "$CURRENT_SECTION" == "storage" ]]; then
          STORAGE_TYPE="$value"
        fi
        ;;
      "url")
        if [[ "$CURRENT_SECTION" == "kv" ]]; then
          KV_URL="$value"
        fi
        ;;
      "rest_url") KV_REST_URL="$value" ;;
      "rest_token") KV_REST_TOKEN="$value" ;;
      "bucket") STORAGE_BUCKET="$value" ;;
      "region") STORAGE_REGION="$value" ;;
      "access_key") STORAGE_ACCESS_KEY="$value" ;;
      "secret_key") STORAGE_SECRET_KEY="$value" ;;
      "google_client_id") GOOGLE_CLIENT_ID="$value" ;;
      "google_client_secret") GOOGLE_CLIENT_SECRET="$value" ;;
      "github_client_id") GITHUB_CLIENT_ID="$value" ;;
      "github_client_secret") GITHUB_CLIENT_SECRET="$value" ;;
      "zepto_api_key") ZEPTO_API_KEY="$value" ;;
    esac
    
    # Track current section
    if [[ "$key" =~ ^\[(.+)\]$ ]]; then
      CURRENT_SECTION="${BASH_REMATCH[1]}"
    fi
  done < "$CONFIG_FILE"
fi

# Set defaults for URLs if not provided
if [ -z "$BASE_URL" ]; then
  BASE_URL="http://localhost:7878"
fi
if [ -z "$APP_URL" ]; then
  APP_URL="http://localhost:5173"
fi

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "[ERROR] Please run as root (use sudo)"
  exit 1
fi

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    PLATFORM="linux"
    ;;
  Darwin)
    PLATFORM="darwin"
    ;;
  *)
    echo "[ERROR] Unsupported OS: $OS"
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64)
    ARCH="x86_64"
    ;;
  aarch64|arm64)
    ARCH="aarch64"
    ;;
  *)
    echo "[ERROR] Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

# Create service user
if ! id "$SERVICE_USER" &>/dev/null; then
  echo "[INFO] Creating service user: $SERVICE_USER"
  useradd --system --no-create-home --shell /bin/false "$SERVICE_USER"
fi

# Create directories
mkdir -p "$INSTALL_DIR"
mkdir -p "$CONFIG_DIR"
mkdir -p /var/log/dployr-base
mkdir -p /var/lib/dployr-base/storage

# Resolve latest tag if requested
if [ "$VERSION" = "latest" ]; then
  echo "[INFO] Resolving latest release tag from GitHub..."
  VERSION="$(curl -fsSL https://api.github.com/repos/dployr-io/dployr-base/releases/latest \
    | grep -m1 '"tag_name"' \
    | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"

  if [ -z "$VERSION" ]; then
    echo "[ERROR] Failed to resolve latest release tag from GitHub."
    exit 1
  fi

  echo "[INFO] Latest release tag: $VERSION"
fi

# Download and extract
echo "[INFO] Downloading Dployr Base ($VERSION)..."
DOWNLOAD_URL="https://github.com/dployr-io/dployr-base/releases/download/${VERSION}/dployr-base-${VERSION}.tar.gz"

curl -fsSL "$DOWNLOAD_URL" | tar -xz -C "$INSTALL_DIR"

# Create default config if not exists
if [ ! -f "$CONFIG_DIR/config.toml" ]; then
  echo "[INFO] Creating default configuration..."
  cat > "$CONFIG_DIR/config.toml" <<EOF
[server]
port = $PORT
host = "$HOST"
base_url = "$BASE_URL"
app_url = "$APP_URL"

[database]
url = "$DB_URL"
auto_migrate = true

[kv]
type = "$KV_TYPE"
host = "$KV_HOST"
port = $KV_PORT
username = "$KV_USERNAME"
password = "$KV_PASSWORD"
rest_url = "$KV_REST_URL"
rest_token = "$KV_REST_TOKEN"

[storage]
type = "$STORAGE_TYPE"
path = "$STORAGE_PATH"
bucket = "$STORAGE_BUCKET"
region = "$STORAGE_REGION"
access_key = "$STORAGE_ACCESS_KEY"
secret_key = "$STORAGE_SECRET_KEY"

[auth]
google_client_id = "$GOOGLE_CLIENT_ID"
google_client_secret = "$GOOGLE_CLIENT_SECRET"
github_client_id = "$GITHUB_CLIENT_ID"
github_client_secret = "$GITHUB_CLIENT_SECRET"

[email]
provider = "$EMAIL_PROVIDER"
zepto_api_key = "$ZEPTO_API_KEY"

[security]
session_ttl = 86400
jwt_algorithm = "RS256"
global_rate_limit = 100
strict_rate_limit = 10
EOF

  echo "[INFO] Configuration created at $CONFIG_DIR/config.toml"
  
  # Show what was configured
  echo "[INFO] Configuration summary:"
  echo "  - KV Store: $KV_TYPE"
  echo "  - Storage: $STORAGE_TYPE"
  echo "  - Base URL: $BASE_URL"
  
  if [ -z "$GOOGLE_CLIENT_ID" ] && [ -z "$GITHUB_CLIENT_ID" ]; then
    echo "[WARN] No OAuth providers configured. Users won't be able to log in."
    echo "[WARN] Add credentials to $CONFIG_DIR/config.toml before starting."
  fi
fi

# Install dependencies
echo "[INFO] Installing dependencies..."
cd "$INSTALL_DIR"
npm install --omit=dev

# Install optional KV dependencies based on configuration
case "$KV_TYPE" in
  "redis")
    echo "[INFO] Installing redis client (kv.type=redis)..."
    npm install --omit=dev redis
    ;;
  "upstash")
    echo "[INFO] Installing @upstash/redis client (kv.type=upstash)..."
    npm install --omit=dev @upstash/redis
    ;;
esac

# Create systemd service
echo "[INFO] Creating systemd service..."
cat > /etc/systemd/system/dployr-base.service <<EOF
[Unit]
Description=Dployr Base Server

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

# Set permissions
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" /var/log/dployr-base
chown -R "$SERVICE_USER:$SERVICE_USER" /var/lib/dployr-base
chmod 600 "$CONFIG_DIR/config.toml"

# Fix TLS cert permissions for Caddy (if certs exist)
if [ -d "$CONFIG_DIR/tls" ] && [ -f "$CONFIG_DIR/tls/cf-origin.crt" ]; then
	echo "[INFO] Setting TLS certificate permissions for Caddy..."
	chown caddy:caddy "$CONFIG_DIR/tls/cf-origin.crt" "$CONFIG_DIR/tls/cf-origin.key" 2>/dev/null || true
	chmod 640 "$CONFIG_DIR/tls/cf-origin.crt" "$CONFIG_DIR/tls/cf-origin.key" 2>/dev/null || true
fi

# Reload systemd
systemctl daemon-reload

echo "[INFO] Enabling and (re)starting dployr-base service..."
systemctl enable dployr-base >/dev/null 2>&1 || true
if systemctl is-active --quiet dployr-base; then
  echo "[INFO] Restarting existing dployr-base service..."
  systemctl restart dployr-base
else
  echo "[INFO] Starting dployr-base service..."
  systemctl start dployr-base
fi

# Configure reverse proxy
if command -v caddy &> /dev/null && [ -d /etc/caddy ]; then
	CADDYFILE="/etc/caddy/Caddyfile"
	if [ ! -f "$CADDYFILE" ]; then
		echo "Configuring Caddy to proxy :80 -> 127.0.0.1:$PORT ..."
		cat > "$CADDYFILE" <<EOF
:80 {
	reverse_proxy 127.0.0.1:$PORT
}
EOF
	else
		echo "Caddyfile already exists; skipping..."
	fi

	# Reload Caddy service if managed by systemd
	if command -v systemctl &> /dev/null; then
		if systemctl is-active --quiet caddy; then
			echo "Reloading Caddy configuration..."
			systemctl restart caddy 2>/dev/null || true
		else
			echo "Caddy service not running; skipping reload."
		fi
	fi
fi

echo ""
echo "Installation completed successfully!"
echo ""
