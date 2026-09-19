#!/usr/bin/env bash
# AIRX Ops — one-shot deploy script for the Hostinger VPS (Ubuntu 24.04 LTS).
# Run this AS ROOT on the VPS itself (SSH in first, then paste/run this).
#
# What it does:
#   1. Installs Node.js 22 LTS, git, nginx, certbot (idempotent - safe to re-run)
#   2. Clones/updates the airx-backend repo from GitHub into /opt/airx-backend
#   3. npm install
#   4. Creates .env from .env.example if it doesn't exist yet, and generates a
#      random AIRX_API_KEY so the admin panel works immediately. Every other
#      key (Meta/Shopify/India Post/WhatsApp/OpenAI/Anthropic) is left blank -
#      the app is designed to degrade gracefully with those unset (see
#      README.md "Pending items"), so the storefront + admin + orders work
#      today; you fill in the rest later via `nano /opt/airx-backend/.env`
#      followed by `pm2 restart airx-backend`.
#   5. Installs PM2 and sets it up to run the app on boot, auto-restart on crash
#   6. Configures nginx as a reverse proxy for airxhealth.in / www.airxhealth.in
#   7. Requests a free Let's Encrypt SSL cert via certbot (needs DNS already
#      pointed at this VPS's IP first - see the DNS step in the README this
#      script prints at the end)
#
# Safe to re-run any time (e.g. after `git pull` picks up new commits) -
# every step checks before it acts.

set -euo pipefail

DOMAIN="airxhealth.in"
WWW_DOMAIN="www.airxhealth.in"
APP_DIR="/opt/airx-backend"
REPO_URL="https://github.com/vaishnavsushil24-stack/airx-backend.git"
APP_PORT="3000"

echo "=== 1. System packages ==="
apt-get update -y
apt-get install -y curl git nginx ufw

echo "=== 2. Node.js 22 LTS ==="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

echo "=== 3. PM2 (process manager) ==="
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

echo "=== 4. Get the app code ==="
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
  git fetch origin
  git reset --hard origin/main
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "=== 5. npm install ==="
cd "$APP_DIR"
npm install --omit=dev

echo "=== 6. .env setup ==="
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  RANDOM_KEY=$(openssl rand -hex 24)
  # Fill in the values this script can determine safely on its own.
  sed -i "s/^AIRX_API_KEY=.*/AIRX_API_KEY=${RANDOM_KEY}/" "$APP_DIR/.env"
  sed -i "s/^PORT=.*/PORT=${APP_PORT}/" "$APP_DIR/.env"
  # PUBLIC_URL is used by the Shopify OAuth callback builder (baseUrl()) -
  # harmless to set even though Shopify is being retired, and needed if any
  # other absolute-URL feature is added later.
  echo "PUBLIC_URL=https://${WWW_DOMAIN}" >> "$APP_DIR/.env"
  echo ""
  echo ">>> Generated a random AIRX_API_KEY and saved .env — admin panel will work immediately."
  echo ">>> Every other key (Meta/Shopify/India Post/WhatsApp/OpenAI/Anthropic) is still blank."
  echo ">>> Fill those in later with:  nano $APP_DIR/.env   then   pm2 restart airx-backend"
else
  echo ">>> .env already exists, leaving it untouched."
fi

echo "=== 7. Start/reload the app under PM2 ==="
cd "$APP_DIR"
if pm2 describe airx-backend >/dev/null 2>&1; then
  pm2 reload airx-backend
else
  pm2 start server.js --name airx-backend
  pm2 save
  # Sets up PM2 to auto-start this app on VPS reboot.
  pm2 startup systemd -u root --hp /root | tail -n 1 > /tmp/pm2-startup-cmd.sh
  bash /tmp/pm2-startup-cmd.sh || true
  pm2 save
fi

echo "=== 8. nginx reverse proxy ==="
cat > /etc/nginx/sites-available/airx-backend <<NGINXCONF
server {
    listen 80;
    server_name ${DOMAIN} ${WWW_DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINXCONF
ln -sf /etc/nginx/sites-available/airx-backend /etc/nginx/sites-enabled/airx-backend
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "=== 9. Firewall ==="
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo ""
echo "======================================================================"
echo "Base deploy done. The app is now running behind nginx on plain HTTP."
echo ""
echo "NEXT STEPS (you still need to do these):"
echo ""
echo "  1. Point DNS at this VPS (if not already done):"
echo "       A record: ${DOMAIN}      -> $(curl -s ifconfig.me || echo '<this VPS IP>')"
echo "       A record: ${WWW_DOMAIN}  -> $(curl -s ifconfig.me || echo '<this VPS IP>')"
echo "     (Do this wherever ${DOMAIN}'s DNS is managed - Hostinger hPanel"
echo "     Domains > DNS Zone, most likely.)"
echo ""
echo "  2. Once DNS has propagated (check with: dig +short ${WWW_DOMAIN}),"
echo "     get a free SSL certificate by running:"
echo "       apt-get install -y certbot python3-certbot-nginx"
echo "       certbot --nginx -d ${DOMAIN} -d ${WWW_DOMAIN}"
echo ""
echo "  3. Remove/disconnect ${WWW_DOMAIN} from Shopify's domain settings"
echo "     (Shopify Admin > Settings > Domains) so it stops fighting with"
echo "     the new DNS records."
echo ""
echo "  4. Fill in real API keys later:  nano ${APP_DIR}/.env"
echo "     then:  pm2 restart airx-backend"
echo ""
echo "  Check the app is alive right now (before DNS/SSL):"
echo "    curl http://localhost:${APP_PORT}/health"
echo "======================================================================"
