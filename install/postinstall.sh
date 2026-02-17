#!/bin/bash
# CertKeeper — post-install script (runs after .deb/.rpm install)
set -e

APP_USER="certkeeper"
APP_GROUP="certkeeper"

# Create system group and user (if they don't exist)
if ! getent group "$APP_GROUP" >/dev/null 2>&1; then
    groupadd --system "$APP_GROUP"
fi
if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$APP_GROUP" "$APP_USER"
fi

# Ensure directory ownership
chown root:"$APP_GROUP" /var/lib/certkeeper
chmod 750 /var/lib/certkeeper

chown root:"$APP_GROUP" /var/log/certkeeper
chmod 750 /var/log/certkeeper

chown root:"$APP_GROUP" /etc/certkeeper
chmod 750 /etc/certkeeper

if [ -f /etc/certkeeper/certkeeper.env ]; then
    chown root:"$APP_GROUP" /etc/certkeeper/certkeeper.env
    chmod 640 /etc/certkeeper/certkeeper.env
fi

# Ensure certbot directories exist with proper permissions
mkdir -p /etc/letsencrypt /var/lib/letsencrypt
chmod 755 /etc/letsencrypt /var/lib/letsencrypt

# Check for and warn about conflicting certbot timers/cron jobs
CONFLICTS_FOUND=0

if systemctl is-active --quiet certbot.timer 2>/dev/null; then
    echo ""
    echo "WARNING: certbot.timer is active on this system."
    echo "  CertKeeper manages its own renewal schedule."
    echo "  Running both may cause Let's Encrypt rate limit issues."
    echo "  To disable: sudo systemctl disable --now certbot.timer"
    echo ""
    CONFLICTS_FOUND=1
fi

if [ -f /etc/cron.d/certbot ]; then
    echo ""
    echo "WARNING: /etc/cron.d/certbot exists on this system."
    echo "  CertKeeper manages its own renewal schedule."
    echo "  Running both may cause Let's Encrypt rate limit issues."
    echo "  To disable: sudo mv /etc/cron.d/certbot /etc/cron.d/certbot.disabled"
    echo ""
    CONFLICTS_FOUND=1
fi

if [ "$CONFLICTS_FOUND" -eq 0 ]; then
    echo "No conflicting certbot timers or cron jobs detected."
fi

# Reload systemd and enable the service
systemctl daemon-reload
systemctl enable certkeeper.service

echo ""
echo "CertKeeper installed successfully!"
echo ""
echo "  Config:  /etc/certkeeper/certkeeper.env"
echo "  Data:    /var/lib/certkeeper/"
echo "  Logs:    /var/log/certkeeper/"
echo "  App:     /opt/certkeeper/"
echo ""
echo "  Start:   sudo systemctl start certkeeper"
echo "  Status:  sudo systemctl status certkeeper"
echo "  Logs:    sudo journalctl -u certkeeper -f"
echo ""
echo "  Open https://localhost:3000 after starting to complete setup."
echo ""
