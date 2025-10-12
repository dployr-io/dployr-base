#!/usr/bin/env bash

HOME_DIR=$(getent passwd "$USER" | cut -d: -f6)
STATE_DIR="$HOME_DIR/.dployr/state"
TMP_DIR="/tmp/dployr"
mkdir -p "$STATE_DIR"
CDN="https://github.com/dployr-io/dployr"
INSTALL_START_TIME=$(date +%s)

# console color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color


# Progress bar function with in-place updates
show_progress() {
    local current=$1
    local total=$2
    local message="$3"
    local width=50
    local percentage=$((current * 100 / total))
    local completed=$((current * width / total))
    
    # Clear line and move cursor to beginning
    printf "\r\033[K"
    
    # Show progress bar
    printf "["
    for ((i=0; i<completed; i++)); do printf "#"; done
    for ((i=completed; i<width; i++)); do printf "-"; done
    printf "] %3d%% %s" "$percentage" "$message"
    
    # Add newline only when complete
    if [ "$current" -eq "$total" ]; then
        printf "\n"
    fi
}

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}
log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}
log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}
log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_sudo() {
    echo "Checking sudo privileges..."
    if [ "$EUID" -ne 0 ]; then
        log_error "This script must be run as root or with sudo privileges"
        echo "Please run: sudo $0"
        exit 1
    fi
    log_success "Running with sudo privileges"
}

create_dployr_user() {
    local flag_file="$STATE_DIR/create_dployr_user.flag"
    if [ -f "$flag_file" ]; then
        log_info "dployr user already created. Skipping."
        return 0
    fi
    log_info "Creating dployr user..."

    if ! id "dployr" &>/dev/null; then
        useradd -r -m -s /bin/bash -d /home/dployr dployr
        log_success "Created dployr user"
    else
        log_warning "User dployr already exists"
    fi
    
    cat > /etc/sudoers.d/dployr << EOF
dployr ALL=(ALL) NOPASSWD: /bin/systemctl start dployr
dployr ALL=(ALL) NOPASSWD: /bin/systemctl stop dployr
dployr ALL=(ALL) NOPASSWD: /bin/systemctl restart dployr
dployr ALL=(ALL) NOPASSWD: /bin/systemctl restart caddy
dployr ALL=(ALL) NOPASSWD: /bin/systemctl reload caddy
dployr ALL=(ALL) NOPASSWD: /bin/systemctl restart php8.3-fpm
dployr ALL=(ALL) NOPASSWD: /bin/systemctl reload php8.3-fpm
dployr ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/caddy/Caddyfile
dployr ALL=(ALL) NOPASSWD: /usr/bin/caddy validate --config /etc/caddy/Caddyfile
dployr ALL=(ALL) NOPASSWD: /bin/chown caddy\:caddy *
dployr ALL=(ALL) NOPASSWD: /bin/chmod * *
EOF
    
    chmod 440 /etc/sudoers.d/dployr
    log_success "Configured safe sudo permissions for dployr"
}

get_latest_tag() {
    local headers tag
    headers=$(curl -sLI "$CDN/releases/latest")
    tag=$(echo "$headers" | grep -i "location:" | grep -o 'tag/v\?[0-9]\+\.[0-9]\+\(\.[0-9]\+\)\?[-a-zA-Z0-9._]*' | head -1 | cut -d'/' -f2)
    
    if [ -z "$tag" ]; then
        echo "Error: No version found in redirect" >&2
        return 1
    fi
    [[ "$tag" =~ ^v ]] || tag="v$tag"
    echo "$tag"
}

download_dployr() {
    local flag_file="$STATE_DIR/download_dployr.flag"
    if [ -f "$flag_file" ]; then
        log_info "dployr application already downloaded. Skipping."
        return 0
    fi

    log_info "Downloading dployr..."
    local server_dir="/home/dployr"

    mkdir -p $server_dir
    log_info "Getting latest release information..."

    LATEST_TAG=$(get_latest_tag)
    if [ $? -ne 0 ] || [ -z "$LATEST_TAG" ]; then
        log_error "Error occurred while obtaining release tag"
        exit 1
    fi

    DOWNLOAD_URL="$CDN/releases/download/$LATEST_TAG/dployr-$LATEST_TAG.zip"
    log_info "Downloading from: $DOWNLOAD_URL"

    if curl -fsSL "$DOWNLOAD_URL" -o $TMP_DIR/dployr.zip; then
        log_info "Extracting archive..."
        cd $TMP_DIR || exit 1

        bsdtar -xf dployr.zip -C $server_dir --strip-components 1 || exit 1
        rm -rf dployr.zip 

        log_success "dployr has been downloaded successfully"
    else
        handle_error "Download error" "Error occurred while downloading dployr"
        exit 1
    fi

    touch "$flag_file"
}

configure_dployr() {
    local flag_file="$STATE_DIR/configure_dployr.flag"
    if [ -f "$flag_file" ]; then
        log_info "Environment already configured. Skipping."
        return 0
    fi

    log_info "Configuring environment..."
    
    cd /home/dployr || exit 1

    chown -R dployr:caddy /home/dployr
    
    log_info "Installing Composer dependencies..."
    sudo -u dployr composer install --no-dev --optimize-autoloader
    
    if [ ! -f .env ]; then
        sudo -u dployr cp .env.example .env
        log_info "Created .env file from example"
    fi
    
    log_info "Generating application key..."
    sudo -u dployr php artisan key:generate --force

    log_info "Setting up database..."
    sudo -u dployr touch database/database.sqlite
    
    log_info "Setting proper permissions..."
    find /home/dployr -type d -exec chmod 775 {} \;
    find /home/dployr -type f -exec chmod 664 {} \;
    chmod -R 775 storage bootstrap/cache database
    chown -R dployr:caddy storage bootstrap/cache database
    chown dployr:caddy .env
    chmod 664 .env

    sed -i "s|^APP_URL=.*|APP_URL=http://${PUBLIC_IP}:7879|" .env
    sed -i "s|^ASSET_URL=.*|ASSET_URL=http://${PUBLIC_IP}:7879|" .env
    #TODO: Re-enable the production settings (debug enabled temporarily for troubleshooting)
    # sed -i "s|^APP_DEBUG=.*|APP_DEBUG=false|" .env
    # sed -i "s|^APP_ENV=.*|APP_ENV=production|" .env

    #TODO: Move this to a separate method
    # Setup PHP-FPM to run as dployr user
    sed -i 's/^user = .*/user = dployr/' /etc/php/8.3/fpm/pool.d/www.conf
    sed -i 's/^group = .*/group = caddy/' /etc/php/8.3/fpm/pool.d/www.conf
    sed -i 's/^;*listen.owner = .*/listen.owner = dployr/' /etc/php/8.3/fpm/pool.d/www.conf
    sed -i 's/^;*listen.group = .*/listen.group = caddy/' /etc/php/8.3/fpm/pool.d/www.conf

    log_info "Running database migrations..."
    sudo -u dployr php artisan migrate --graceful --force
    sudo -u dployr php artisan db:seed 

    systemctl restart php8.3-fpm
 
    log_success "Environment configured successfully"
    touch "$flag_file"
}

install_requirements() {
    local flag_file="$STATE_DIR/install_requirements.flag"
    if [ -f "$flag_file" ]; then
        log_info "System requirements already installed. Skipping."
        return 0
    fi

    log_info "Installing system requirements..."

    OS_TYPE=$(grep -w "ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
    OS_VERSION=$(grep -w "VERSION_CODENAME" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
    
    log_info "Detected OS: $OS_TYPE $OS_VERSION"
    
    export DEBIAN_FRONTEND=noninteractive
    export DEBCONF_NONINTERACTIVE_SEEN=true
    
    case "$OS_TYPE" in
        ubuntu|debian)
            apt-get update -qq
            apt install -y debian-keyring debian-archive-keyring apt-transport-https software-properties-common
            
            log_info "Download PHP 8.3 repository..."
            if [ "$OS_TYPE" = "ubuntu" ]; then
                add-apt-repository -y ppa:ondrej/php
            else
                curl -fsSL https://packages.sury.org/php/apt.gpg | gpg --dearmor -o /usr/share/keyrings/sury-php-keyring.gpg
                echo "deb [signed-by=/usr/share/keyrings/sury-php-keyring.gpg] https://packages.sury.org/php/ $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/sury-php.list
            fi
            
            log_info "Setting up PHP 8.3 repository locally..."
            curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
            curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
            chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
            chmod o+r /etc/apt/sources.list.d/caddy-stable.list
            
            apt-get update -qq
            
            PHP_PACKAGES="php8.3-fpm php8.3-cli php8.3-common php8.3-dom php8.3-curl php8.3-mbstring php8.3-xml php8.3-zip php8.3-bcmath php8.3-intl php8.3-gd php8.3-sqlite3 php8.3-tokenizer composer"
            PACKAGES="curl wget git jq libarchive-tools caddy ca-certificates gnupg ufw openssl net-tools unzip ansible $PHP_PACKAGES"
            
            apt-get install -y $PACKAGES
            
            log_info "Starting fpm..."
            systemctl enable php8.3-fpm
            systemctl start php8.3-fpm
            ;;
        centos|rhel|rocky|alma)
            yum install -y epel-release
            
            log_info "Instally remy repository for PHP 8.3..."
            yum install -y "https://rpms.remirepo.net/enterprise/remi-release-$(rpm -E %rhel).rpm"
            yum-config-manager --enable remi-php83
            
            log_info "Installing Caddy..."
            yum install -y yum-plugin-copr
            yum copr enable -y @caddy/caddy

            PHP_PACKAGES="php php-fpm php-cli php-common php-dom php-curl php-mbstring php-xml php-zip php-bcmath php-intl php-gd php-sqlite3 composer"
            
            yum install -y curl wget libarchive-tools git jq caddy ufw openssl ansible $PHP_PACKAGES

            log_info "Starting fpm..."
            systemctl enable php-fpm
            systemctl start php-fpm
            ;;
        *)
            handle_error "Package error" "Error occurred while installing required packages" 
            exit 1
            ;;
    esac
    
    log_success "System requirements installed"
    touch "$flag_file"
}

setup_directories() {
    local flag_file="$STATE_DIR/setup_directories.flag"
    if [ -f "$flag_file" ]; then
        log_info "Directories already created. Skipping."
        return 0
    fi
    
    log_info "Setting up directories..."
    
    
    mkdir -p /home/dployr/{apps,builds,logs,ssl}
    mkdir -p /var/log
    touch /var/log/dployr.log
    
    log_success "Directories created"
}

determine_ip_addr() {
    local public_ip=""
    local private_ip=""
    
    if ! private_ip=$(curl -s "https://api.ipify.org"); then
        echo "Error: failed to get public IP address" >&2
        return 1
    fi
    
    # Trim whitespace
    private_ip=$(echo "$private_ip" | tr -d '[:space:]')
    
    # Get public IP - find first non-loopback IPv4 address on active interface
    public_ip=$(ip route get 8.8.8.8 2>/dev/null | grep -oP 'src \K\S+' | head -1)
    
    # Fallback
    if [[ -z "$public_ip" ]]; then
        public_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    fi
    
    if [[ -z "$public_ip" ]]; then
        echo "Error: no public IP found" >&2
        return 1
    fi

    export PUBLIC_IP="$public_ip"
    export PRIVATE_IP="$private_ip"
    
    echo "Public IP: $public_ip"
    echo "Private IP: $private_ip"
    return 0
}

create_systemd_service() {    
    log_info "Creating systemd service..."

# worker service
    cat > /etc/systemd/system/dployr.service << EOF
[Unit]
Description=dployr worker
After=network.target php8.3-fpm.service

[Service]
Type=simple
ExecStart=/usr/bin/php /home/dployr/artisan queue:work --sleep=3 --tries=3 --max-time=3600
Restart=on-failure
User=dployr
Group=www-data
WorkingDirectory=/home/dployr
StandardOutput=append:/var/log/dployr.log
StandardError=inherit
Environment=APP_ENV=production

[Install]
WantedBy=multi-user.target
EOF
    
    systemctl daemon-reload
    systemctl enable dployr
    log_success "Systemd services created and enabled"
}

setup_caddy() {

    log_info "Setting up caddy configuration..."
    
    APP_FOLDER="/home/dployr"

#TODO: Add admin email for certbot auto-renewal email 
# e.g email: dployr@yourdomain.com
    cat > /etc/caddy/Caddyfile << EOF
{
    auto_https disable_redirects
}

:7879 {
    root * $APP_FOLDER/public
    php_fastcgi unix//run/php/php8.3-fpm.sock 

    try_files {path} {path}/ /index.php?{query}

    file_server
    encode gzip

    @static {
        file
        path *.ico *.css *.js *.gif *.jpg *.jpeg *.png *.svg *.woff *.pdf *.webp
    }
	header @static Cache-Control max-age=5184000
    header {
        -Server
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
    }
}

import sites-enabled/*.conf
EOF

    log_info "Setting up permissions..."
    if ! chown root:root /etc/caddy/Caddyfile; then
        handle_error "Permission error" "Failed to set Caddyfile ownership"
        return 1
    fi

     if ! usermod -aG caddy dployr; then
        handle_error "Permission error" "Failed to add dployr to caddy group"
        return 1
    fi

    if ! mkdir -p /etc/caddy/sites-enabled; then 
        handle_error "Permission error" "Failed to create sites-enabled folder"
        return 1
    fi

    if ! chown -R caddy:caddy /etc/caddy/sites-enabled; then
        handle_error "Permission error" "Failed to set Caddyfile ownership"
        return 1
    fi

    # NOTE: Ensure you don't assume that you can merge the next two commands below
    # The recursive method will lead to open permissions
    # for the caddy folder - you don't want that
    if ! chmod 755 /etc/caddy; then 
        handle_error "Permission error" "Failed to set permissions for caddy sites-enabled configurations"
        return 1
    fi

    if ! chmod -R 755 /etc/caddy/sites-enabled; then 
        handle_error "Permission error" "Failed to set permissions for caddy sites-enabled configurations"
        return 1
    fi

    if ! chmod 644 /etc/caddy/Caddyfile; then
        handle_error "Permission error" "Failed to set Caddyfile permissions"
        return 1
    fi

    log_info "Opening firewall ports..."
    ufw allow 80 2>/dev/null || true
    ufw allow 443 2>/dev/null || true
    ufw allow 7879 2>/dev/null || true
    ufw allow 22 2>/dev/null || true

    log_info "Restarting Caddy service..."
    if ! systemctl restart caddy; then
        handle_error "Caddy restart error" "Failed to restart Caddy service"
        return 1
    fi

    if systemctl is-active --quiet caddy; then
        if [ "$PUBLIC_IP" != "$PRIVATE_IP" ]; then
            log_info "Available at: https://$PUBLIC_IP:7879 and http://$PRIVATE_IP:7879"
        else
            log_info "Available at: https://$PRIVATE_IP:7879"
        fi
    else
        handle_error "Caddy setup error" "Caddy service failed to start properly"
        return 1
    fi
}


start_dployr() {
    log_info "Starting dployr..."
    
    systemctl start dployr
    sleep 2
    
    if systemctl is-active --quiet dployr; then
        log_success "dployr started successfully"
    else
        handle_error "Program error" "Failed to start dployr services"
        exit 1
    fi
}

show_completion() {
    INSTALL_END_TIME=$(date +%s)
    INSTALL_DURATION=$((INSTALL_END_TIME - INSTALL_START_TIME))
    MINUTES=$((INSTALL_DURATION / 60))
    SECONDS=$((INSTALL_DURATION % 60))
    
    echo ""
    echo "╔══════════════════════════════════════╗"
    echo "║        INSTALLATION COMPLETE         ║"
    echo "╚══════════════════════════════════════╝"
    echo ""
    log_success "Installation completed in ${MINUTES}m ${SECONDS}s"
    echo ""
    echo "Access your dployr installation at:"
    
    if [ "$PUBLIC_IP" = "$PRIVATE_IP" ]; then
        echo "  http://$PRIVATE_IP:7879"
    else
        echo "  http://$PUBLIC_IP:7879"
        echo "  http://$PRIVATE_IP:7879"
    fi
    
    echo ""
    echo "Service management:"
    echo "  Start:   sudo systemctl start dployr"
    echo "  Stop:    sudo systemctl stop dployr"
    echo "  Status:  sudo systemctl status dployr"
    echo "  Logs:    tail -f /var/log/dployr.log"
    echo ""
}

exec 3>&1 4>&2

handle_error() {
    local step_name="$1"
    local error_msg="$2"
    
    {
        printf "\n\n"
        echo -e "${RED}[ERROR]${NC} Installation failed during: $step_name"
        if [ -n "$error_msg" ]; then
            echo "Error: $error_msg"
        fi
        echo ""
        echo "Last 20 lines from install log:"
        echo "================================"
        sync
        if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
            tail -20 "$LOG_FILE"
        else
            echo "No log content available"
        fi
        echo "================================"
        echo ""
        echo "Full log available at: $LOG_FILE"
        echo ""
    } >/dev/tty 2>&1
}

main() {
    echo "Starting dployr installer..."
    echo ""

    mkdir -p $TMP_DIR

    LOG_FILE="$TMP_DIR/dployr-install-$(date +%Y%m%d-%H%M%S).log"
    echo "Installation started at $(date)" > "$LOG_FILE"
    
    check_sudo
    
    TOTAL_STEPS=9
    CURRENT_STEP=0
    
    show_progress $CURRENT_STEP $TOTAL_STEPS "Creating user..."
    if ! create_dployr_user >> "$LOG_FILE" 2>&1; then
        exit 1
    fi

    show_progress $CURRENT_STEP $TOTAL_STEPS "Determining IP address..."
    if ! determine_ip_addr >> "$LOG_FILE" 2>&1; then
        exit 1
    fi
    
    ((CURRENT_STEP++))
    show_progress $CURRENT_STEP $TOTAL_STEPS "Installing requirements..."
    if ! install_requirements >> "$LOG_FILE" 2>&1; then
        exit 1
    fi

    ((CURRENT_STEP++))
    show_progress $CURRENT_STEP $TOTAL_STEPS "Downloading archive..."
    if ! download_dployr >> "$LOG_FILE" 2>&1; then
        exit 1
    fi
    
    ((CURRENT_STEP++))
    show_progress $CURRENT_STEP $TOTAL_STEPS "Configuring Environment..."
    if ! configure_dployr >> "$LOG_FILE" 2>&1; then
        exit 1
    fi
    
    ((CURRENT_STEP++))
    show_progress $CURRENT_STEP $TOTAL_STEPS "Creating directories..."
    if ! setup_directories >> "$LOG_FILE" 2>&1; then
        exit 1
    fi
    
    ((CURRENT_STEP++))
    show_progress $CURRENT_STEP $TOTAL_STEPS "Configuring services..."
    if ! create_systemd_service >> "$LOG_FILE" 2>&1; then
        exit 1
    fi
    
    ((CURRENT_STEP++))
    show_progress $CURRENT_STEP $TOTAL_STEPS "Setting up caddy..."
    if ! setup_caddy >> "$LOG_FILE" 2>&1; then
        exit 1
    fi
    
    ((CURRENT_STEP++))
    show_progress $CURRENT_STEP $TOTAL_STEPS "Starting services..."
    if ! start_dployr >> "$LOG_FILE" 2>&1; then
        exit 1
    fi
    
    show_progress $TOTAL_STEPS $TOTAL_STEPS "Complete!"
    echo ""
    echo ""
    
    show_completion
}

main "$@"
