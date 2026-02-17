#!/bin/bash
# CertKeeper — pre-remove script (runs before .deb/.rpm uninstall)
set -e

# Stop and disable the service (ignore errors if not running)
if systemctl is-active --quiet certkeeper.service 2>/dev/null; then
    echo "Stopping CertKeeper service..."
    systemctl stop certkeeper.service || true
fi

if systemctl is-enabled --quiet certkeeper.service 2>/dev/null; then
    echo "Disabling CertKeeper service..."
    systemctl disable certkeeper.service || true
fi

systemctl daemon-reload || true

echo ""
echo "CertKeeper service stopped and disabled."
echo ""
echo "  Data preserved at:   /var/lib/certkeeper/"
echo "  Config preserved at: /etc/certkeeper/"
echo "  Logs preserved at:   /var/log/certkeeper/"
echo "  Certs preserved at:  /etc/letsencrypt/"
echo ""
echo "  These directories are NOT removed on uninstall."
echo "  Delete them manually if you no longer need them."
echo ""
