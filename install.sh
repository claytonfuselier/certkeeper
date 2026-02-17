#!/bin/bash
# ============================================================================
# CertKeeper Installer
# https://github.com/claytonfuselier/certkeeper
#
# Usage:
#   Install (latest):   sudo bash install.sh
#   Install (version):  sudo bash install.sh --version 1.2.0
#   Uninstall:          sudo bash install.sh --uninstall
#   Non-interactive:    sudo bash install.sh --yes
# ============================================================================
set -euo pipefail

REPO="claytonfuselier/certkeeper"
APP_NAME="certkeeper"
APP_USER="certkeeper"
APP_GROUP="certkeeper"
INSTALL_DIR="/opt/certkeeper"
DATA_DIR="/var/lib/certkeeper"
LOG_DIR="/var/log/certkeeper"
CONFIG_DIR="/etc/certkeeper"
ENV_FILE="${CONFIG_DIR}/certkeeper.env"
SERVICE_FILE="/etc/systemd/system/certkeeper.service"

# Minimum Node.js major version
MIN_NODE_VERSION=24

# CLI args
REQUESTED_VERSION=""
UNINSTALL=false
AUTO_YES=false

# Terminal colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()  { echo -e "${BLUE}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✔${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
error() { echo -e "${RED}✖${NC}  $*" >&2; }
fatal() { error "$*"; exit 1; }

confirm() {
    if [ "$AUTO_YES" = true ]; then return 0; fi
    read -rp "   $1 [y/N] " answer
    case "$answer" in
        [yY]|[yY][eE][sS]) return 0 ;;
        *) return 1 ;;
    esac
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version|-v)
            REQUESTED_VERSION="$2"
            shift 2
            ;;
        --uninstall|--remove)
            UNINSTALL=true
            shift
            ;;
        --yes|-y)
            AUTO_YES=true
            shift
            ;;
        --help|-h)
            echo "Usage: sudo bash install.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --version, -v VERSION   Install a specific version (e.g. 1.2.0)"
            echo "  --uninstall, --remove   Remove CertKeeper (preserves data)"
            echo "  --yes, -y               Non-interactive mode (auto-confirm prompts)"
            echo "  --help, -h              Show this help"
            exit 0
            ;;
        *)
            fatal "Unknown option: $1 (use --help for usage)"
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Root check
# ---------------------------------------------------------------------------

if [ "$(id -u)" -ne 0 ]; then
    fatal "This script must be run as root. Use: sudo bash install.sh"
fi

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

if [ "$UNINSTALL" = true ]; then
    echo ""
    echo "CertKeeper Uninstaller"
    echo "======================"
    echo ""

    # Stop and disable service
    if systemctl is-active --quiet certkeeper.service 2>/dev/null; then
        info "Stopping CertKeeper service..."
        systemctl stop certkeeper.service
    fi
    if systemctl is-enabled --quiet certkeeper.service 2>/dev/null; then
        systemctl disable certkeeper.service 2>/dev/null || true
    fi

    # Remove based on how it was installed
    if dpkg -l certkeeper &>/dev/null; then
        info "Removing .deb package..."
        apt-get remove -y certkeeper || dpkg --remove certkeeper
    elif rpm -q certkeeper &>/dev/null; then
        info "Removing .rpm package..."
        if command -v dnf &>/dev/null; then
            dnf remove -y certkeeper
        else
            yum remove -y certkeeper
        fi
    else
        # Manual/tarball install — remove files directly
        info "Removing application files..."
        rm -rf "$INSTALL_DIR"
        rm -f "$SERVICE_FILE"
        systemctl daemon-reload
    fi

    ok "CertKeeper removed."
    echo ""
    echo "  The following data directories were preserved:"
    echo "    ${DATA_DIR}/"
    echo "    ${CONFIG_DIR}/"
    echo "    ${LOG_DIR}/"
    echo "    /etc/letsencrypt/"
    echo ""
    echo "  Delete them manually if no longer needed."

    # Optionally remove the system user
    if id "$APP_USER" &>/dev/null; then
        if confirm "Remove the '${APP_USER}' system user?"; then
            userdel "$APP_USER" 2>/dev/null || true
            ok "User '${APP_USER}' removed."
        fi
    fi
    if getent group "$APP_GROUP" &>/dev/null; then
        groupdel "$APP_GROUP" 2>/dev/null || true
    fi

    echo ""
    exit 0
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

echo ""
echo "CertKeeper Installer"
echo "====================="
echo ""

# Detect distro family
detect_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        case "$ID" in
            debian|ubuntu|raspbian|linuxmint|pop) echo "debian" ;;
            rhel|centos|fedora|rocky|alma|ol)     echo "rhel" ;;
            alpine)                                echo "alpine" ;;
            *)
                # Check ID_LIKE for derivatives
                case "${ID_LIKE:-}" in
                    *debian*|*ubuntu*) echo "debian" ;;
                    *rhel*|*fedora*)   echo "rhel" ;;
                    *)                 echo "unknown" ;;
                esac
                ;;
        esac
    else
        echo "unknown"
    fi
}

detect_arch() {
    local arch
    arch=$(uname -m)
    case "$arch" in
        x86_64|amd64)  echo "amd64" ;;
        aarch64|arm64) echo "arm64" ;;
        *)             echo "$arch" ;;
    esac
}

DISTRO=$(detect_distro)
ARCH=$(detect_arch)

info "Detected: distro=${DISTRO}, arch=${ARCH}"

if [ "$DISTRO" = "unknown" ]; then
    warn "Unsupported distribution. Will attempt tarball install."
fi

# ---------------------------------------------------------------------------
# Step 1: Check / install Node.js
# ---------------------------------------------------------------------------

check_node() {
    if ! command -v node &>/dev/null; then
        return 1
    fi
    local ver
    ver=$(node -v | sed 's/^v//' | cut -d. -f1)
    if [ "$ver" -lt "$MIN_NODE_VERSION" ]; then
        return 1
    fi
    return 0
}

install_node() {
    info "Installing Node.js ${MIN_NODE_VERSION}.x..."
    case "$DISTRO" in
        debian)
            if ! command -v curl &>/dev/null; then
                apt-get update -qq && apt-get install -y -qq curl ca-certificates
            fi
            # NodeSource setup
            curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_VERSION}.x" | bash -
            apt-get install -y -qq nodejs
            ;;
        rhel)
            if ! command -v curl &>/dev/null; then
                yum install -y -q curl
            fi
            curl -fsSL "https://rpm.nodesource.com/setup_${MIN_NODE_VERSION}.x" | bash -
            if command -v dnf &>/dev/null; then
                dnf install -y -q nodejs
            else
                yum install -y -q nodejs
            fi
            ;;
        *)
            fatal "Cannot auto-install Node.js on this distro. Please install Node.js ${MIN_NODE_VERSION}+ manually."
            ;;
    esac
}

if check_node; then
    ok "Node.js $(node -v) found"
else
    if command -v node &>/dev/null; then
        warn "Node.js $(node -v) found, but ${MIN_NODE_VERSION}+ is required."
    else
        warn "Node.js not found."
    fi
    if confirm "Install Node.js ${MIN_NODE_VERSION}.x via NodeSource?"; then
        install_node
        ok "Node.js $(node -v) installed"
    else
        fatal "Node.js ${MIN_NODE_VERSION}+ is required. Install it and re-run this script."
    fi
fi

# ---------------------------------------------------------------------------
# Step 2: Check / install certbot
# ---------------------------------------------------------------------------

install_certbot() {
    info "Installing certbot and certbot-dns-cloudflare..."
    if command -v pip3 &>/dev/null || command -v pip &>/dev/null; then
        local pip_cmd
        pip_cmd=$(command -v pip3 || command -v pip)
        "$pip_cmd" install --quiet certbot certbot-dns-cloudflare
    elif [ "$DISTRO" = "debian" ]; then
        apt-get install -y -qq python3-pip
        pip3 install --quiet certbot certbot-dns-cloudflare
    elif [ "$DISTRO" = "rhel" ]; then
        if command -v dnf &>/dev/null; then
            dnf install -y -q python3-pip
        else
            yum install -y -q python3-pip
        fi
        pip3 install --quiet certbot certbot-dns-cloudflare
    else
        fatal "Cannot auto-install certbot. Please install certbot and certbot-dns-cloudflare manually."
    fi
}

if command -v certbot &>/dev/null; then
    ok "certbot found: $(certbot --version 2>&1 | head -1)"
else
    warn "certbot not found."
    if confirm "Install certbot and certbot-dns-cloudflare via pip?"; then
        install_certbot
        ok "certbot installed: $(certbot --version 2>&1 | head -1)"
    else
        warn "Continuing without certbot — certificate operations will fail until it's installed."
    fi
fi

# ---------------------------------------------------------------------------
# Step 3: Check for conflicting certbot timers/cron
# ---------------------------------------------------------------------------

if systemctl is-active --quiet certbot.timer 2>/dev/null; then
    echo ""
    warn "certbot.timer is active. CertKeeper manages its own renewal schedule."
    warn "Running both may cause Let's Encrypt rate limit issues."
    if confirm "Disable certbot.timer?"; then
        systemctl disable --now certbot.timer
        ok "certbot.timer disabled"
    else
        warn "Leaving certbot.timer active — you may want to disable it later."
    fi
fi

if [ -f /etc/cron.d/certbot ]; then
    echo ""
    warn "/etc/cron.d/certbot found. CertKeeper manages its own renewal schedule."
    if confirm "Disable it (rename to certbot.disabled)?"; then
        mv /etc/cron.d/certbot /etc/cron.d/certbot.disabled
        ok "Moved to /etc/cron.d/certbot.disabled"
    else
        warn "Leaving /etc/cron.d/certbot in place — you may want to disable it later."
    fi
fi

# ---------------------------------------------------------------------------
# Step 4: Determine version and download
# ---------------------------------------------------------------------------

if [ -z "$REQUESTED_VERSION" ]; then
    info "Fetching latest release version..."
    if ! command -v curl &>/dev/null; then
        fatal "curl is required. Install it and re-run."
    fi
    REQUESTED_VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
    if [ -z "$REQUESTED_VERSION" ]; then
        fatal "Could not determine latest version. Use --version to specify one."
    fi
fi

info "Installing CertKeeper v${REQUESTED_VERSION}"

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${REQUESTED_VERSION}"

# Try native package first, fall back to tarball
INSTALLED_VIA=""

install_deb() {
    local pkg="certkeeper_${REQUESTED_VERSION}_${ARCH}.deb"
    local url="${DOWNLOAD_URL}/${pkg}"
    info "Downloading ${pkg}..."
    local tmp
    tmp=$(mktemp /tmp/certkeeper-XXXXX.deb)
    if curl -fsSL -o "$tmp" "$url"; then
        dpkg -i "$tmp" || apt-get install -f -y
        rm -f "$tmp"
        INSTALLED_VIA="deb"
        return 0
    fi
    rm -f "$tmp"
    return 1
}

install_rpm() {
    local pkg="certkeeper-${REQUESTED_VERSION}-1.${ARCH/amd64/x86_64}.rpm"
    local url="${DOWNLOAD_URL}/${pkg}"
    info "Downloading ${pkg}..."
    local tmp
    tmp=$(mktemp /tmp/certkeeper-XXXXX.rpm)
    if curl -fsSL -o "$tmp" "$url"; then
        if command -v dnf &>/dev/null; then
            dnf install -y "$tmp"
        else
            yum install -y "$tmp"
        fi
        rm -f "$tmp"
        INSTALLED_VIA="rpm"
        return 0
    fi
    rm -f "$tmp"
    return 1
}

install_tarball() {
    local pkg="certkeeper-${REQUESTED_VERSION}-linux-${ARCH}.tar.gz"
    local url="${DOWNLOAD_URL}/${pkg}"
    info "Downloading ${pkg}..."
    local tmp
    tmp=$(mktemp /tmp/certkeeper-XXXXX.tar.gz)
    if ! curl -fsSL -o "$tmp" "$url"; then
        rm -f "$tmp"
        fatal "Failed to download ${url}"
    fi

    # Extract to /opt/certkeeper
    rm -rf "${INSTALL_DIR}.new"
    mkdir -p "${INSTALL_DIR}.new"
    tar xzf "$tmp" -C "${INSTALL_DIR}.new" --strip-components=1
    rm -f "$tmp"

    # Atomic-ish swap
    if [ -d "$INSTALL_DIR" ]; then
        rm -rf "${INSTALL_DIR}.old"
        mv "$INSTALL_DIR" "${INSTALL_DIR}.old"
    fi
    mv "${INSTALL_DIR}.new" "$INSTALL_DIR"
    rm -rf "${INSTALL_DIR}.old"

    # Create system user/group
    if ! getent group "$APP_GROUP" >/dev/null 2>&1; then
        groupadd --system "$APP_GROUP"
    fi
    if ! id "$APP_USER" >/dev/null 2>&1; then
        useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$APP_GROUP" "$APP_USER"
    fi

    # Create directories
    mkdir -p "$DATA_DIR" "$LOG_DIR" "$CONFIG_DIR" /etc/letsencrypt /var/lib/letsencrypt

    chown root:"$APP_GROUP" "$DATA_DIR" && chmod 750 "$DATA_DIR"
    chown root:"$APP_GROUP" "$LOG_DIR"  && chmod 750 "$LOG_DIR"
    chown root:"$APP_GROUP" "$CONFIG_DIR" && chmod 750 "$CONFIG_DIR"

    # Install env file if not present
    if [ ! -f "$ENV_FILE" ]; then
        cp "${INSTALL_DIR}/install/certkeeper.env" "$ENV_FILE"
        chown root:"$APP_GROUP" "$ENV_FILE"
        chmod 640 "$ENV_FILE"
    fi

    # Install systemd unit
    cp "${INSTALL_DIR}/install/certkeeper.service" "$SERVICE_FILE"
    systemctl daemon-reload
    systemctl enable certkeeper.service

    INSTALLED_VIA="tarball"
}

# Attempt install
case "$DISTRO" in
    debian)
        install_deb || install_tarball
        ;;
    rhel)
        install_rpm || install_tarball
        ;;
    *)
        install_tarball
        ;;
esac

ok "CertKeeper v${REQUESTED_VERSION} installed (via ${INSTALLED_VIA})"

# ---------------------------------------------------------------------------
# Step 5: Start the service
# ---------------------------------------------------------------------------

echo ""
if confirm "Start CertKeeper now?"; then
    systemctl start certkeeper.service
    ok "CertKeeper is running"
    echo ""
    echo "  Open https://localhost:3000 to complete setup."
else
    echo ""
    echo "  Start later with:  sudo systemctl start certkeeper"
fi

echo ""
echo "  Config:   ${ENV_FILE}"
echo "  Data:     ${DATA_DIR}/"
echo "  Logs:     ${LOG_DIR}/ and journalctl -u certkeeper"
echo "  Service:  sudo systemctl {start|stop|restart|status} certkeeper"
echo ""
